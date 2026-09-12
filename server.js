/**
 * 局域网快传 —— 极简信令 + 静态文件服务器（零第三方依赖）
 *
 * 职责：
 *   1. 托管 public/ 下的前端页面（HTML/CSS/JS）
 *   2. 基于 SSE（Server-Sent Events）做在线设备发现
 *   3. 转发 WebRTC 信令：offer / answer / ICE candidate
 *
 * 注意：本服务器只转发“建连信令”，文字与文件数据一律走浏览器之间的
 * WebRTC DataChannel 直连，不经过本服务器。
 *
 * 启动：node server.js   （默认端口 3000，可用 PORT=8080 node server.js 覆盖）
 */

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 512 * 1024; // 信令报文上限 512KB（SDP/ICE 体积很小）

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8'
};

/** 在线客户端表：id -> { id, name, res(SSE响应对象) } */
const clients = new Map();

function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcastPeers() {
  const list = [...clients.values()].map((c) => ({ id: c.id, name: c.name }));
  for (const c of clients.values()) {
    try {
      sseSend(c.res, 'peers', list);
    } catch (_) {
      /* 对端已关闭，交由 close 事件清理 */
    }
  }
}

function getLanIPv4List() {
  const result = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const item of nets[name] || []) {
      if (item.family === 'IPv4' && !item.internal) {
        result.push({ iface: name, address: item.address });
      }
    }
  }
  return result;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));

  // 防路径穿越
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;

  // ---------- SSE：设备注册 + 事件流 ----------
  // GET /api/events?name=xxx  （id 由浏览器在会话内保持，断线重连沿用）
  if (pathname === '/api/events' && req.method === 'GET') {
    const id = String(url.searchParams.get('id') || '').slice(0, 64);
    const name = String(url.searchParams.get('name') || '匿名设备').slice(0, 32);

    if (!/^[A-Za-z0-9_-]{4,64}$/.test(id)) {
      res.writeHead(400);
      res.end('bad id');
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 2000\n\n');
    sseSend(res, 'welcome', { id, name });

    // 同 id 旧连接（标签页刷新/网络抖动重连）：替换之
    const old = clients.get(id);
    if (old) {
      try {
        old.res.end();
      } catch (_) {}
    }
    const client = { id, name, res };
    clients.set(id, client);
    console.log(`[上线] ${name} (${id})，当前在线 ${clients.size}`);
    broadcastPeers();

    // SSE 心跳，避免反向代理/浏览器因空闲断开
    const keepAlive = setInterval(() => {
      try {
        res.write(': ka\n\n');
      } catch (_) {}
    }, 20000);

    req.on('close', () => {
      clearInterval(keepAlive);
      // 仅当归属的仍是当前响应时才清理（重连场景下可能已被新连接替换）
      if (clients.get(id) && clients.get(id).res === res) {
        clients.delete(id);
        console.log(`[下线] ${name} (${id})，当前在线 ${clients.size}`);
        broadcastPeers();
      }
    });
    return;
  }

  // ---------- 信令转发 ----------
  // POST /api/signal  { from, target, type, payload }
  if (pathname === '/api/signal' && req.method === 'POST') {
    let msg;
    try {
      msg = await readJsonBody(req);
    } catch (e) {
      res.writeHead(400);
      res.end('bad request');
      return;
    }

    const { from, target, type, payload } = msg;
    if (!from || !target || !['offer', 'answer', 'candidate'].includes(type)) {
      res.writeHead(400);
      res.end('bad signal');
      return;
    }
    const dest = clients.get(String(target));
    if (dest) {
      sseSend(dest.res, 'signal', { from: String(from), type, payload });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    } else {
      // 目标不在线
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"ok":false,"reason":"offline"}');
    }
    return;
  }

  // ---------- 配置：返回本机局域网地址，供页面提示其他设备访问 ----------
  if (pathname === '/api/config' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        port: PORT,
        host: os.hostname(),
        ips: getLanIPv4List().map((i) => i.address)
      })
    );
    return;
  }

  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  serveStatic(req, res, pathname);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，请设置其他端口：PORT=8080 node server.js`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  const ips = getLanIPv4List();
  console.log('');
  console.log('  ============================================');
  console.log('   局域网快传已启动（信令服务 + 静态页面）');
  console.log('  ============================================');
  console.log(`   本机访问 : http://localhost:${PORT}`);
  if (ips.length === 0) {
    console.log('   未检测到局域网 IPv4 地址，请检查网络连接');
  } else {
    for (const item of ips) {
      console.log(`   局域网   : http://${item.address}:${PORT}`);
    }
  }
  console.log('   其他设备（手机/另一台电脑）用浏览器打开上面的局域网地址即可');
  console.log('   文字与文件均通过 WebRTC 点对点直连，不经过服务器');
  console.log('');
});
