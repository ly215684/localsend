/* ==========================================================================
   局域网快传 —— 前端逻辑
   架构：SSE 负责设备发现与 WebRTC 信令转发（offer/answer/candidate）
         WebRTC DataChannel 承载全部业务数据（文字 + 文件），P2P 直连
   文件协议：
     字符串消息(JSON)：
       {t:'msg',         ts, text}
       {t:'file-req',    id, name, size, mime}
       {t:'file-accept', id, ok}
       {t:'file-cancel', id}
     二进制消息(ArrayBuffer)：9 字节头部 + 数据
       byte0      类型（1=分片 2=结束）
       uint32 BE  transferId
       uint32 BE  chunkSeq
       其余       文件分片数据（每片 64KB，背压阈值 4MB）
   ========================================================================== */

'use strict';

/* ------------------------------ DOM 快捷方式 ------------------------------ */

const $ = (id) => document.getElementById(id);

const sidebar = $('sidebar');
const peerListEl = $('peerList');
const peerEmptyEl = $('peerEmpty');
const peerCountEl = $('peerCount');
const connStateEl = $('connState');
const selfNameInput = $('selfName');
const accessTextEl = $('accessText');

const chatAvatarEl = $('chatAvatar');
const chatNameEl = $('chatName');
const chatStatusEl = $('chatStatus');
const disconnectBtn = $('disconnectBtn');
const messagesEl = $('messages');
const messagesWrap = $('messagesWrap');
const attachBtn = $('attachBtn');
const fileInput = $('fileInput');
const textInput = $('textInput');
const sendBtn = $('sendBtn');
const backBtn = $('backBtn');
const toastEl = $('toast');

/* -------------------------------- 常量 -------------------------------- */

const CHUNK_SIZE = 64 * 1024;        // 单片 64KB
const BUFFER_HIGH = 4 * 1024 * 1024; // 发送缓冲超过 4MB 时等待背压
const BUFFER_LOW = 1 * 1024 * 1024;
const ACCEPT_TIMEOUT = 60 * 1000;
const MAX_MSGS = 300;

const AVATAR_COLORS = [
  '#f97316', '#ef4444', '#8b5cf6', '#3b82f6', '#06b6d4',
  '#10b981', '#84cc16', '#eab308', '#ec4899', '#6366f1'
];

const STATUS_TEXT = {
  offline: '已离线',
  online: '在线 · 点击连接',
  connecting: '连接中…',
  connected: '已连接'
};

/* -------------------------------- 状态 -------------------------------- */

let nidSeq = 0;

const state = {
  selfId: null,
  selfName: '我的设备',
  /** @type {Map<string, Peer>} */
  peers: new Map(),
  activeId: null
};

/**
 * @typedef {Object} Peer
 * @property {string} id
 * @property {string} name
 * @property {boolean} online
 * @property {'offline'|'online'|'connecting'|'connected'} status
 * @property {RTCPeerConnection|null} pc
 * @property {RTCDataChannel|null} dc
 * @property {RTCIceCandidateInit[]} queuedCand
 * @property {Array} msgs
 * @property {number} unread
 * @property {number} nextTid
 * @property {Map<number, {chunks: Blob[], received: number, msg: any}>} incoming
 * @property {Map<number, (ok:boolean)=>void>} waits
 * @property {Promise<void>} queue
 */

function makePeerObj(id, name, online) {
  return {
    id,
    name,
    online,
    status: online ? 'online' : 'offline',
    pc: null,
    dc: null,
    queuedCand: [],
    msgs: [],
    unread: 0,
    nextTid: 1,
    incoming: new Map(),
    waits: new Map(),
    queue: Promise.resolve()
  };
}

// 全局只读便捷访问：当前选中的会话对象
Object.defineProperty(globalThis, 'activePeer', {
  configurable: true,
  get() {
    return state.activeId ? (state.peers.get(state.activeId) || null) : null;
  }
});

/* ------------------------------ 工具函数 ------------------------------ */

function h(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

function randomId() {
  return 'u' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
}

function hashIndex(str, mod) {
  let x = 0;
  for (let i = 0; i < str.length; i++) {
    x = (x * 31 + str.charCodeAt(i)) >>> 0;
  }
  return x % mod;
}

function avatarColor(id) {
  return AVATAR_COLORS[hashIndex(id, AVATAR_COLORS.length)];
}

function firstChar(name) {
  const s = (name || '?').trim();
  return s ? s[0].toUpperCase() : '?';
}

function formatBytes(n) {
  if (n == null || isNaN(n)) return '';
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2) + ' ' + units[i];
}

function fmtTime(ts) {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, '0') + ':' +
         String(d.getMinutes()).padStart(2, '0');
}

function fileEmoji(name, mime) {
  const m = (mime || '').toLowerCase();
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (m.startsWith('image/')) return '🖼️';
  if (m.startsWith('video/')) return '🎬';
  if (m.startsWith('audio/')) return '🎵';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2'].includes(ext) || m.includes('compressed')) return '📦';
  if (['apk', 'exe', 'dmg', 'ipa', 'deb', 'msi'].includes(ext)) return '💾';
  if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md'].includes(ext) ||
      m.includes('pdf') || m.includes('word') || m.includes('excel') || m.includes('text')) return '📄';
  return '📄';
}

let toastTimer = null;
function toast(text, ms = 2200) {
  toastEl.textContent = text;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, ms);
}

/* ========================================================================
   一、信令通道（SSE + POST）
   ======================================================================== */

let es = null;

function connectSSE() {
  if (es) {
    try { es.close(); } catch (_) {}
    es = null;
  }
  setSignalingState('connecting');

  const url = '/api/events?id=' + encodeURIComponent(state.selfId) +
              '&name=' + encodeURIComponent(state.selfName);
  es = new EventSource(url);

  es.addEventListener('welcome', (e) => {
    const d = JSON.parse(e.data);
    state.selfName = d.name;
    if (selfNameInput.value !== d.name) selfNameInput.value = d.name;
    setSignalingState('ok');
  });

  es.addEventListener('peers', (e) => {
    onPeersList(JSON.parse(e.data) || []);
  });

  es.addEventListener('signal', (e) => {
    const d = JSON.parse(e.data);
    onSignal(d.from, d.type, d.payload);
  });

  es.onopen = () => setSignalingState('ok');

  es.onerror = () => {
    // EventSource 会自动重连；SSE 断开不影响已建立的 WebRTC 直连
    setSignalingState('err');
  };
}

function setSignalingState(s) {
  connStateEl.classList.remove('ok', 'err');
  if (s === 'ok') {
    connStateEl.classList.add('ok');
    connStateEl.textContent = '信令已连接 · 设备发现中';
  } else if (s === 'err') {
    connStateEl.classList.add('err');
    connStateEl.textContent = '信令断开，正在自动重连…';
  } else {
    connStateEl.textContent = '信令连接中…';
  }
}

function sendSignal(target, type, payload) {
  fetch('/api/signal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: state.selfId, target, type, payload })
  }).catch(() => toast('信令服务器不可达，请检查网络'));
}

function onPeersList(list) {
  const onlineIds = new Set();
  for (const p of list) {
    if (!p || p.id === state.selfId) continue;
    onlineIds.add(p.id);
    const ex = state.peers.get(p.id);
    if (ex) {
      ex.online = true;
      ex.name = p.name || ex.name;
    } else {
      state.peers.set(p.id, makePeerObj(p.id, p.name || '未知设备', true));
    }
  }
  // SSE 短暂抖动会造成离线误判；已建立的 WebRTC 连接不受影响
  for (const peer of state.peers.values()) {
    if (!onlineIds.has(peer.id)) {
      peer.online = false;
      if (peer.status === 'online') peer.status = 'offline';
    }
  }
  renderPeerList();
  refreshChatHead();
}

/* ========================================================================
   二、WebRTC 连接管理
   ======================================================================== */

function ensurePeer(id, name) {
  let peer = state.peers.get(id);
  if (!peer) {
    peer = makePeerObj(id, name || '未知设备', true);
    state.peers.set(id, peer);
  }
  return peer;
}

function createPeerConnection(peer) {
  const RTCPC = window.RTCPeerConnection || window.webkitRTCPeerConnection;
  if (!RTCPC) {
    toast('当前浏览器不支持 WebRTC，请使用现代浏览器');
    return null;
  }
  // 同一局域网仅需 host candidate，无需 STUN/TURN；切勿设置 iceTransportPolicy:'relay'
  const pc = new RTCPC({ iceServers: [] });

  pc.onicecandidate = (e) => {
    if (e.candidate) sendSignal(peer.id, 'candidate', e.candidate);
  };

  pc.onconnectionstatechange = () => {
    const cs = pc.connectionState;
    if (cs === 'failed') {
      addSysMessage(peer, '连接失败，网络可能不可达，请重新点击设备发起连接');
      resetConnection(peer);
      refreshPeerUI(peer);
    } else {
      refreshPeerUI(peer);
    }
  };

  pc.ondatachannel = (e) => bindDataChannel(peer, e.channel);

  return pc;
}

/** 点击设备列表项：发起连接或切换会话 */
async function connectOrSelect(peer) {
  selectPeer(peer.id);
  if (peer.status === 'connected' || peer.status === 'connecting') return;
  if (!peer.online) {
    toast('对方当前不在线');
    return;
  }

  peer.status = 'connecting';
  const pc = createPeerConnection(peer);
  if (!pc) return;
  peer.pc = pc;

  const dc = pc.createDataChannel('transfer', { ordered: true });
  bindDataChannel(peer, dc);

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal(peer.id, 'offer', offer);
  } catch (err) {
    console.error(err);
    toast('建立连接失败：' + (err.message || err));
    resetConnection(peer);
  }
  refreshPeerUI(peer);
}

async function onSignal(from, type, payload) {
  const peer = ensurePeer(from);

  try {
    if (type === 'offer') {
      await handleOffer(peer, payload);
    } else if (type === 'answer') {
      if (!peer.pc || !peer.pc.localDescription) return;
      await peer.pc.setRemoteDescription(payload);
      await flushQueuedCandidates(peer);
    } else if (type === 'candidate') {
      if (peer.pc && peer.pc.remoteDescription) {
        await peer.pc.addIceCandidate(payload).catch(() => {});
      } else {
        // offer/answer 尚未落地，先缓存
        peer.queuedCand.push(payload);
      }
    }
  } catch (err) {
    console.error('signal error', type, err);
  }
}

async function handleOffer(peer, offer) {
  // glare 处理：双方几乎同时发起时，id 较大的一方让步（关闭自己的 offer，接受对方的）
  if (peer.status === 'connecting' &&
      peer.pc && peer.pc.localDescription && peer.pc.localDescription.type === 'offer' &&
      !(peer.pc.remoteDescription)) {
    if (state.selfId > peer.id) {
      resetConnection(peer);
    } else {
      return; // 我方发起优先，忽略对方 offer
    }
  } else if (peer.status === 'connected' || peer.pc) {
    // 对端页面刷新后重新发起：静默替换旧连接
    resetConnection(peer);
  }

  peer.status = 'connecting';
  const pc = createPeerConnection(peer);
  if (!pc) return;
  peer.pc = pc;

  await pc.setRemoteDescription(offer);
  await flushQueuedCandidates(peer);

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  sendSignal(peer.id, 'answer', answer);
  refreshPeerUI(peer);
}

async function flushQueuedCandidates(peer) {
  const cands = peer.queuedCand;
  peer.queuedCand = [];
  for (const c of cands) {
    await peer.pc.addIceCandidate(c).catch(() => {});
  }
}

function disconnectPeer(peer) {
  addSysMessage(peer, '你已主动断开连接');
  resetConnection(peer);
  refreshPeerUI(peer);
  toast('已断开连接');
}

/** 清理 RTCPeerConnection / DataChannel，不弹系统消息（消息由调用方负责） */
function resetConnection(peer) {
  const { dc, pc } = peer;
  peer.dc = null;
  peer.pc = null;
  if (dc) {
    dc.onopen = null;
    dc.onclose = null;
    dc.onerror = null;
    dc.onmessage = null;
    try { dc.close(); } catch (_) {}
  }
  if (pc) {
    pc.onicecandidate = null;
    pc.onconnectionstatechange = null;
    pc.ondatachannel = null;
    try { pc.close(); } catch (_) {}
  }
  peer.queuedCand = [];
  peer.status = peer.online ? 'online' : 'offline';

  for (const resolve of peer.waits.values()) resolve(false);
  peer.waits.clear();

  for (const rec of peer.incoming.values()) {
    if (rec.msg.status === 'receiving' || rec.msg.status === 'requested') {
      rec.msg.status = 'failed';
      rec.msg._update && rec.msg._update();
    }
  }
  peer.incoming.clear();
}

/* ========================================================================
   三、DataChannel：文字与文件
   ======================================================================== */

function bindDataChannel(peer, dc) {
  peer.dc = dc;
  dc.binaryType = 'arraybuffer';
  try { dc.bufferedAmountLowThreshold = BUFFER_LOW; } catch (_) {}

  dc.onopen = () => {
    peer.status = 'connected';
    addSysMessage(peer, '🔒 P2P 加密直连已建立，消息与文件不经过任何服务器');
    refreshPeerUI(peer);
  };

  dc.onclose = () => {
    if (peer.status === 'connected') {
      addSysMessage(peer, '连接已断开');
    } else if (peer.status === 'connecting') {
      addSysMessage(peer, '连接未能建立，请重试');
    }
    resetConnection(peer);
    refreshPeerUI(peer);
  };

  dc.onerror = (e) => {
    console.warn('datachannel error', e);
  };

  dc.onmessage = (e) => {
    if (typeof e.data === 'string') {
      let d;
      try { d = JSON.parse(e.data); } catch (_) { return; }
      handleControlMessage(peer, d);
    } else {
      handleBinaryMessage(peer, e.data);
    }
  };
}

function sendJson(peer, obj) {
  try {
    peer.dc.send(JSON.stringify(obj));
    return true;
  } catch (err) {
    console.warn('send failed', err);
    toast('发送失败：连接已关闭');
    return false;
  }
}

/* ------------------------------- 文字消息 ------------------------------- */

function sendText() {
  const peer = activePeer;
  if (!peer || peer.status !== 'connected') return;
  const text = textInput.value;
  if (!text.trim()) return;

  const msg = { nid: ++nidSeq, kind: 'text', dir: 'out', ts: Date.now(), text };
  pushMessage(peer, msg);
  sendJson(peer, { t: 'msg', ts: msg.ts, text });

  textInput.value = '';
  autoGrowText();
}

function handleControlMessage(peer, d) {
  switch (d.t) {
    case 'msg': {
      const msg = {
        nid: ++nidSeq,
        kind: 'text',
        dir: 'in',
        ts: d.ts || Date.now(),
        text: String(d.text == null ? '' : d.text)
      };
      pushMessage(peer, msg);
      if (state.activeId !== peer.id) {
        peer.unread++;
        renderPeerList();
      }
      break;
    }
    case 'file-req': {
      const id = Number(d.id) >>> 0;
      if (peer.msgs.some((m) => m.kind === 'file' && m.id === id && m.dir === 'in')) return;
      const msg = {
        nid: ++nidSeq,
        kind: 'file',
        dir: 'in',
        ts: Date.now(),
        id,
        name: String(d.name || '未命名文件'),
        size: Math.max(0, Number(d.size) || 0),
        mime: String(d.mime || 'application/octet-stream'),
        progress: 0,
        status: 'requested',
        url: null
      };
      pushMessage(peer, msg);
      if (state.activeId !== peer.id) {
        peer.unread++;
        renderPeerList();
      }
      if (isMobileScreen()) toast('收到来自 ' + peer.name + ' 的文件：' + msg.name, 3200);
      break;
    }
    case 'file-accept': {
      const resolve = peer.waits.get(Number(d.id) >>> 0);
      if (resolve) {
        peer.waits.delete(Number(d.id) >>> 0);
        resolve(!!d.ok);
      }
      break;
    }
    case 'file-cancel': {
      const id = Number(d.id) >>> 0;
      const rec = peer.incoming.get(id);
      if (rec) {
        rec.msg.status = 'canceled';
        rec.msg._update && rec.msg._update();
        peer.incoming.delete(id);
      }
      const m = peer.msgs.find((x) => x.kind === 'file' && x.id === id && x.dir === 'in');
      if (m && (m.status === 'requested' || m.status === 'receiving')) {
        m.status = 'canceled';
        m._update && m._update();
      }
      break;
    }
  }
}

/* ------------------------------- 文件发送 ------------------------------- */

function enqueueFiles(peer, files) {
  if (!peer || peer.status !== 'connected') {
    toast('请先与设备建立连接');
    return;
  }
  const list = Array.from(files);
  if (!list.length) return;

  for (const file of list) {
    peer.queue = peer.queue
      .then(() => sendFile(peer, file))
      .catch((err) => console.warn('queue error', err));
  }
  toast(list.length === 1
    ? '开始发送：' + list[0].name
    : '已加入 ' + list.length + ' 个文件到发送队列');
}

async function sendFile(peer, file) {
  const id = peer.nextTid++;
  const msg = {
    nid: ++nidSeq,
    kind: 'file',
    dir: 'out',
    ts: Date.now(),
    id,
    name: file.name,
    size: file.size,
    mime: file.type || 'application/octet-stream',
    progress: 0,
    status: 'waiting',
    url: null
  };
  pushMessage(peer, msg);

  if (!sendJson(peer, { t: 'file-req', id, name: file.name, size: file.size, mime: msg.mime })) {
    msg.status = 'failed';
    msg._update && msg._update();
    return;
  }

  const accepted = await new Promise((resolve) => {
    peer.waits.set(id, resolve);
    setTimeout(() => {
      if (peer.waits.has(id)) {
        peer.waits.delete(id);
        resolve(false);
      }
    }, ACCEPT_TIMEOUT);
  });

  if (msg.status === 'canceled') return;
  if (!accepted) {
    msg.status = 'declined';
    msg._update && msg._update();
    return;
  }

  msg.status = 'sending';
  msg._update && msg._update();

  let offset = 0;
  let seq = 0;
  try {
    while (offset < file.size) {
      if (msg.status === 'canceled') break;
      if (!peer.dc || peer.status !== 'connected') throw new Error('channel closed');

      const buf = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
      await sendBinaryChunk(peer.dc, 1, id, seq, buf);

      offset += buf.byteLength;
      seq++;
      msg.progress = file.size ? offset / file.size : 1;
      scheduleCardUpdate(msg);
    }

    if (msg.status === 'canceled') {
      sendJson(peer, { t: 'file-cancel', id });
      return;
    }

    await sendBinaryChunk(peer.dc, 2, id, seq, null);
    msg.status = 'done';
    msg.progress = 1;
    msg._update && msg._update();
  } catch (err) {
    console.warn('send file error', err);
    if (msg.status !== 'canceled') {
      msg.status = 'failed';
      msg._update && msg._update();
    }
  }
}

/** 发送 9 字节头 + 可选负载，并依据 bufferedAmount 做背压 */
function sendBinaryChunk(dc, type, tid, seq, buf) {
  const payload = buf ? new Uint8Array(buf) : null;
  const merged = new Uint8Array(9 + (payload ? payload.length : 0));
  const dv = new DataView(merged.buffer);
  dv.setUint8(0, type);
  dv.setUint32(1, tid, false);
  dv.setUint32(5, seq, false);
  if (payload) merged.set(payload, 9);

  return new Promise((resolve, reject) => {
    const doSend = () => {
      try {
        dc.send(merged.buffer);
        resolve();
      } catch (err) {
        reject(err);
      }
    };

    if (dc.bufferedAmount > BUFFER_HIGH) {
      const onLow = () => {
        dc.removeEventListener('bufferedamountlow', onLow);
        dc.removeEventListener('close', onClose);
        doSend();
      };
      const onClose = () => {
        dc.removeEventListener('bufferedamountlow', onLow);
        dc.removeEventListener('close', onClose);
        reject(new Error('channel closed while waiting for backpressure'));
      };
      dc.addEventListener('bufferedamountlow', onLow);
      dc.addEventListener('close', onClose);
    } else {
      doSend();
    }
  });
}

/* ------------------------------- 文件接收 ------------------------------- */

function handleBinaryMessage(peer, buffer) {
  if (buffer.byteLength < 9) return;
  const dv = new DataView(buffer);
  const type = dv.getUint8(0);
  const tid = dv.getUint32(1, false);
  const seq = dv.getUint32(5, false);
  const rec = peer.incoming.get(tid);

  if (type === 1) {
    if (!rec) {
      // 我方已取消/拒绝，但对端仍在发送：通知其停止
      sendJson(peer, { t: 'file-cancel', id: tid });
      return;
    }
    const chunk = buffer.slice(9);
    rec.chunks.push(new Blob([chunk]));
    rec.received += chunk.byteLength;
    rec.msg.progress = rec.msg.size ? rec.received / rec.msg.size : 1;
    scheduleCardUpdate(rec.msg);
  } else if (type === 2) {
    if (!rec) return;
    try {
      const blob = new Blob(rec.chunks, { type: rec.msg.mime });
      rec.msg.url = URL.createObjectURL(blob);
      rec.msg.status = rec.received === rec.msg.size ? 'done' : 'failed';
      rec.msg.progress = 1;
      rec.msg._update && rec.msg._update();
      if (rec.msg.status === 'done' && state.activeId === peer.id) {
        toast('接收完成：' + rec.msg.name);
      } else if (rec.msg.status === 'done') {
        toast('文件接收完成：' + rec.msg.name);
      }
    } finally {
      peer.incoming.delete(tid);
    }
    void seq;
  }
}

function acceptIncomingFile(peer, msg) {
  msg.status = 'receiving';
  msg._update && msg._update();
  peer.incoming.set(msg.id, { chunks: [], received: 0, msg });
  sendJson(peer, { t: 'file-accept', id: msg.id, ok: true });
}

function declineIncomingFile(peer, msg) {
  msg.status = 'declined';
  msg._update && msg._update();
  sendJson(peer, { t: 'file-accept', id: msg.id, ok: false });
}

function cancelIncomingFile(peer, msg) {
  msg.status = 'canceled';
  msg._update && msg._update();
  peer.incoming.delete(msg.id);
  sendJson(peer, { t: 'file-cancel', id: msg.id });
}

function cancelOutgoingFile(peer, msg) {
  msg.status = 'canceled';
  msg._update && msg._update();
  const resolve = peer.waits.get(msg.id);
  if (resolve) {
    peer.waits.delete(msg.id);
    resolve(false);
  }
  sendJson(peer, { t: 'file-cancel', id: msg.id });
}

/* 进度刷新节流（高频分片下避免每片都操作 DOM） */
let cardUpdateScheduled = false;
function scheduleCardUpdate() {
  if (cardUpdateScheduled) return;
  cardUpdateScheduled = true;
  requestAnimationFrame(() => {
    cardUpdateScheduled = false;
    for (const peer of state.peers.values()) {
      for (const m of peer.msgs) {
        if (m.kind === 'file' && m._update) {
          if (m.status === 'sending' || m.status === 'receiving') m._update();
        }
      }
    }
  });
}

/* ========================================================================
   四、UI 渲染
   ======================================================================== */

function pushMessage(peer, msg) {
  peer.msgs.push(msg);
  if (peer.msgs.length > MAX_MSGS) peer.msgs.splice(0, peer.msgs.length - MAX_MSGS);
  if (state.activeId === peer.id) {
    messagesEl.appendChild(buildMessageNode(peer, msg));
    scrollToBottomIfNeeded();
  }
}

function addSysMessage(peer, text) {
  pushMessage(peer, { nid: ++nidSeq, kind: 'sys', ts: Date.now(), text });
}

function scrollToBottomIfNeeded() {
  const el = messagesEl;
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
  if (nearBottom) el.scrollTop = el.scrollHeight;
}

function buildPlaceholder() {
  const wrap = h('div', 'chat-placeholder');
  wrap.innerHTML =
    '<div class="placeholder-illus">' +
    '<svg viewBox="0 0 24 24" width="56" height="56" fill="none" stroke="currentColor" ' +
    'stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/></svg></div>' +
    '<p>选择一位在线设备，即可开始加密直连</p>' +
    '<small>支持文字消息、任意大小文件<br/>同一局域网下无需联网</small>';
  return wrap;
}

function buildMessageNode(peer, msg) {
  if (msg.kind === 'sys') {
    return h('div', 'msg-sys', msg.text);
  }
  const row = h('div', 'msg ' + msg.dir);
  if (msg.kind === 'text') {
    const bubble = h('div', 'bubble');
    // 纯文本节点防 XSS，换行由 .bubble 的 white-space:pre-wrap 保留
    bubble.appendChild(h('span', 'msg-text', msg.text));
    bubble.appendChild(h('span', 'time', fmtTime(msg.ts)));
    row.appendChild(bubble);
  } else if (msg.kind === 'file') {
    row.appendChild(buildFileCard(peer, msg));
  }
  return row;
}

function buildFileCard(peer, msg) {
  const card = h('div', 'file-card');

  const main = h('div', 'file-main');
  const icon = h('div', 'file-icon', fileEmoji(msg.name, msg.mime));
  const info = h('div', 'file-info');
  const nameEl = h('div', 'file-name', msg.name);
  const sizeEl = h('div', 'file-size', formatBytes(msg.size));
  info.appendChild(nameEl);
  info.appendChild(sizeEl);
  main.appendChild(icon);
  main.appendChild(info);

  const progress = h('div', 'file-progress');
  const bar = h('div', 'file-progress-bar');
  progress.appendChild(bar);

  const stateEl = h('div', 'file-state');
  const actionsEl = h('div', 'file-actions');

  card.appendChild(main);
  card.appendChild(progress);
  card.appendChild(stateEl);
  card.appendChild(actionsEl);

  msg._update = () => updateFileCard(msg, { bar, stateEl, actionsEl, progress });
  msg._update();
  return card;
}

function updateFileCard(msg, refs) {
  const pct = Math.round((msg.progress || 0) * 100);
  refs.bar.style.width = pct + '%';

  const showProgress = ['waiting', 'sending', 'receiving'].includes(msg.status);
  refs.progress.style.display = showProgress ? 'block' : 'none';
  if (msg.status !== refs.actionsEl.dataset.state) {
    refs.actionsEl.dataset.state = msg.status;
    renderFileActions(msg, refs.actionsEl);
  }

  switch (msg.status) {
    case 'waiting':
      refs.stateEl.textContent = '等待对方接收…';
      break;
    case 'sending':
      refs.stateEl.textContent = '发送中 ' + pct + '% · ' +
        formatBytes(msg.size * msg.progress) + ' / ' + formatBytes(msg.size);
      break;
    case 'receiving':
      refs.stateEl.textContent = '接收中 ' + pct + '% · ' +
        formatBytes(msg.size * msg.progress) + ' / ' + formatBytes(msg.size);
      break;
    case 'done':
      refs.stateEl.textContent = msg.dir === 'out'
        ? '已发送 · ' + formatBytes(msg.size)
        : '接收完成 · ' + formatBytes(msg.size) + ' · 点击下方按钮保存';
      break;
    case 'declined':
      refs.stateEl.textContent = msg.dir === 'out' ? '对方未接收此文件' : '已拒绝接收';
      break;
    case 'canceled':
      refs.stateEl.textContent = msg.dir === 'out' ? '已取消发送' : '对方已取消';
      break;
    case 'failed':
      refs.stateEl.textContent = '传输失败（连接中断）';
      break;
    default:
      refs.stateEl.textContent = '';
  }
}

function renderFileActions(msg, actionsEl) {
  actionsEl.innerHTML = '';

  const mkBtn = (text, cls, act) => {
    const b = h('button', 'file-btn ' + cls, text);
    b.dataset.act = act;
    b.dataset.nid = String(msg.nid);
    return b;
  };

  if (msg.status === 'requested') {
    actionsEl.appendChild(mkBtn('接收', 'primary', 'accept'));
    actionsEl.appendChild(mkBtn('拒绝', 'ghost', 'decline'));
  } else if (msg.status === 'receiving') {
    actionsEl.appendChild(mkBtn('取消接收', 'ghost', 'cancel-in'));
  } else if (msg.status === 'waiting' || msg.status === 'sending') {
    actionsEl.appendChild(mkBtn('取消发送', 'ghost', 'cancel-out'));
  } else if (msg.status === 'done' && msg.dir === 'in' && msg.url) {
    // iOS Safari 对 blob: 的 download 属性支持有限，新窗口打开作为兜底
    const a = document.createElement('a');
    a.className = 'file-btn primary';
    a.href = msg.url;
    a.download = msg.name;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = '保存到设备';
    actionsEl.appendChild(a);
  }
}

/* ------------------------------ 设备列表 ------------------------------ */

function renderPeerList() {
  const peers = Array.from(state.peers.values())
    .filter((p) => p.online || p.status === 'connected' || p.status === 'connecting')
    .sort((a, b) => {
      const w = (p) => p.status === 'connected' ? 0 : p.status === 'connecting' ? 1 : 2;
      const d = w(a) - w(b);
      return d !== 0 ? d : a.name.localeCompare(b.name, 'zh-CN');
    });

  const onlineCount = Array.from(state.peers.values()).filter((p) => p.online).length;
  peerCountEl.textContent = onlineCount;
  peerEmptyEl.style.display = peers.length ? 'none' : 'block';

  // 简单 diff：先移除无效项，再更新/追加，避免滚动跳动
  const existIds = new Set(peers.map((p) => p.id));
  for (const node of Array.from(peerListEl.querySelectorAll('.peer-item'))) {
    if (!existIds.has(node.dataset.id)) node.remove();
  }

  for (const peer of peers) {
    let item = peerListEl.querySelector('.peer-item[data-id="' + cssEscape(peer.id) + '"]');
    if (!item) {
      item = h('button', 'peer-item');
      item.dataset.id = peer.id;
      peerListEl.appendChild(item);
    }
    item.classList.toggle('active', state.activeId === peer.id);
    item.classList.toggle('offline', !peer.online && peer.status !== 'connected');

    item.innerHTML = '';
    const avatar = h('div', 'peer-avatar', firstChar(peer.name));
    avatar.style.background = avatarColor(peer.id);
    avatar.appendChild(h('span', 'status-dot ' + peer.status));
    const info = h('div', 'peer-info');
    info.appendChild(h('div', 'peer-name', peer.name));
    let sub = STATUS_TEXT[peer.status];
    if (peer.unread > 0) sub += ' · ' + peer.unread + ' 条未读';
    info.appendChild(h('div', 'peer-status-text', sub));
    item.appendChild(avatar);
    item.appendChild(info);

    if (peer.unread > 0) {
      const badge = h('span', 'peer-unread', String(peer.unread > 99 ? '99+' : peer.unread));
      badge.style.cssText =
        'background:#ef4444;color:#fff;font-size:11px;min-width:18px;height:18px;' +
        'border-radius:9px;padding:0 5px;display:flex;align-items:center;justify-content:center;';
      item.appendChild(badge);
    }
  }
}

function cssEscape(s) {
  return String(s).replace(/(["\\])/g, '\\$1');
}

/* ------------------------------ 会话头部 ------------------------------ */

function refreshChatHead() {
  const peer = activePeer;
  if (!peer) {
    chatNameEl.textContent = '未选择设备';
    chatAvatarEl.textContent = '?';
    chatAvatarEl.style.background = '';
    chatStatusEl.className = 'chat-status';
    chatStatusEl.textContent = '请从左侧选择一位在线设备';
    disconnectBtn.hidden = true;
    refreshComposer();
    return;
  }

  chatAvatarEl.textContent = firstChar(peer.name);
  chatAvatarEl.style.background = avatarColor(peer.id);
  chatNameEl.textContent = peer.name;

  let cls = 'chat-status';
  let text;
  if (peer.status === 'connected') {
    if (peer.pc && peer.pc.connectionState === 'disconnected') {
      cls += ' connecting';
      text = '网络中断，正在尝试自动恢复…';
    } else {
      cls += ' connected';
      text = '已连接 · P2P 直连中';
    }
  } else if (peer.status === 'connecting') {
    cls += ' connecting';
    text = '正在建立 P2P 连接…';
  } else if (peer.status === 'online') {
    text = '对方在线';
  } else {
    cls += ' offline';
    text = '对方已离线（已建立的连接可能仍可用）';
  }
  chatStatusEl.className = cls;
  chatStatusEl.textContent = text;
  disconnectBtn.hidden = peer.status !== 'connected' && peer.status !== 'connecting';
  refreshComposer();
}

function refreshComposer() {
  const peer = activePeer;
  const ok = !!(peer && peer.status === 'connected');
  textInput.disabled = !ok;
  sendBtn.disabled = !ok;
  attachBtn.disabled = !ok;
  textInput.placeholder = ok
    ? '输入消息，Enter 发送 / Shift+Enter 换行'
    : '请先选择设备并建立连接';
}

function refreshPeerUI(peer) {
  renderPeerList();
  if (state.activeId === peer.id) refreshChatHead();
}

function selectPeer(id) {
  state.activeId = id;
  const peer = state.peers.get(id);
  if (peer) peer.unread = 0;

  messagesEl.innerHTML = '';
  if (peer) {
    for (const m of peer.msgs) messagesEl.appendChild(buildMessageNode(peer, m));
    messagesEl.scrollTop = messagesEl.scrollHeight;
  } else {
    messagesEl.appendChild(buildPlaceholder());
  }

  document.body.classList.add('chat-open');
  renderPeerList();
  refreshChatHead();
}

function isMobileScreen() {
  return window.matchMedia('(max-width: 760px)').matches;
}

/* ========================================================================
   五、事件绑定
   ======================================================================== */

// 设备列表点击
peerListEl.addEventListener('click', (e) => {
  const item = e.target.closest('.peer-item');
  if (!item) return;
  const peer = state.peers.get(item.dataset.id);
  if (peer) connectOrSelect(peer);
});

// 文件卡片按钮（事件委托，随消息重新渲染依然有效）
messagesEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const peer = activePeer;
  if (!peer) return;
  const msg = peer.msgs.find((m) => m.nid === Number(btn.dataset.nid));
  if (!msg || msg.kind !== 'file') return;

  switch (btn.dataset.act) {
    case 'accept': acceptIncomingFile(peer, msg); break;
    case 'decline': declineIncomingFile(peer, msg); break;
    case 'cancel-in': cancelIncomingFile(peer, msg); break;
    case 'cancel-out': cancelOutgoingFile(peer, msg); break;
  }
});

disconnectBtn.addEventListener('click', () => {
  if (activePeer) disconnectPeer(activePeer);
});

backBtn.addEventListener('click', () => {
  document.body.classList.remove('chat-open');
});

// 发送文字
sendBtn.addEventListener('click', sendText);

let composing = false;
textInput.addEventListener('compositionstart', () => { composing = true; });
textInput.addEventListener('compositionend', () => { composing = false; });
textInput.addEventListener('keydown', (e) => {
  // Enter 发送（Shift+Enter 换行；中文输入法组词期间不触发）
  if (e.key === 'Enter' && !e.shiftKey && !composing) {
    e.preventDefault();
    sendText();
  }
});
function autoGrowText() {
  textInput.style.height = 'auto';
  textInput.style.height = Math.min(textInput.scrollHeight, 120) + 'px';
}
textInput.addEventListener('input', autoGrowText);

// 选择文件
attachBtn.addEventListener('click', () => {
  if (!activePeer || activePeer.status !== 'connected') {
    toast('请先与设备建立连接');
    return;
  }
  fileInput.click();
});
fileInput.addEventListener('change', () => {
  if (fileInput.files && fileInput.files.length) {
    enqueueFiles(activePeer, fileInput.files);
  }
  fileInput.value = '';
});

// 拖拽文件（桌面端）
let dragDepth = 0;
messagesWrap.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (!activePeer || activePeer.status !== 'connected') return;
  dragDepth++;
  messagesWrap.classList.add('dragging');
});
messagesWrap.addEventListener('dragover', (e) => e.preventDefault());
messagesWrap.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) messagesWrap.classList.remove('dragging');
});
messagesWrap.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  messagesWrap.classList.remove('dragging');
  const files = e.dataTransfer && e.dataTransfer.files;
  if (files && files.length) {
    enqueueFiles(activePeer, Array.from(files));
  }
});

// 粘贴图片/文件
document.addEventListener('paste', (e) => {
  if (!activePeer || activePeer.status !== 'connected') return;
  const files = e.clipboardData && e.clipboardData.files;
  if (files && files.length) {
    e.preventDefault();
    enqueueFiles(activePeer, Array.from(files));
  }
});

// 修改设备名（防抖后重连 SSE 广播新名字，不影响 WebRTC）
let nameTimer = null;
selfNameInput.addEventListener('input', () => {
  clearTimeout(nameTimer);
  nameTimer = setTimeout(() => {
    const name = selfNameInput.value.trim() || defaultDeviceName();
    state.selfName = name;
    localStorage.setItem('ls_name', name);
    connectSSE();
  }, 700);
});

/* ------------------------------ 初始化 ------------------------------ */

function defaultDeviceName() {
  const ua = navigator.userAgent;
  let kind = '电脑';
  if (/iPhone|Android.*Mobile|Windows Phone/i.test(ua)) kind = '手机';
  else if (/iPad|Tablet/i.test(ua)) kind = '平板';
  return kind + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
}

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const c = await res.json();
    if (c.ips && c.ips.length) {
      const urls = c.ips.map((ip) => 'http://' + ip + ':' + c.port);
      accessTextEl.textContent =
        '同一 Wi-Fi / 局域网内，其他设备用浏览器打开：' + urls.join(' 或 ');
    } else {
      accessTextEl.textContent = '未检测到局域网 IP，请确认本机已接入局域网';
    }
  } catch (_) {
    accessTextEl.textContent = '无法获取局域网地址';
  }
}

/** 移动端弹出的键盘会挤占视口，用 visualViewport 实时修正应用高度 */
function setupViewport() {
  if (!window.visualViewport) return;
  const vv = window.visualViewport;
  const apply = () => {
    document.documentElement.style.setProperty('--app-h', vv.height + 'px');
  };
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  apply();
}

function init() {
  // id 只在当前标签会话内保持（不同标签页使用不同 id，避免互相顶掉 SSE）
  state.selfId = sessionStorage.getItem('ls_id');
  if (!state.selfId) {
    state.selfId = randomId();
    sessionStorage.setItem('ls_id', state.selfId);
  }

  state.selfName = localStorage.getItem('ls_name') || defaultDeviceName();
  localStorage.setItem('ls_name', state.selfName);
  selfNameInput.value = state.selfName;

  if (typeof EventSource === 'undefined') {
    toast('当前浏览器过旧，不支持 SSE（设备发现）');
  }
  if (!(window.RTCPeerConnection || window.webkitRTCPeerConnection)) {
    toast('当前浏览器不支持 WebRTC');
  }

  setupViewport();
  loadConfig();
  connectSSE();
  renderPeerList();
  refreshChatHead();
}

init();
