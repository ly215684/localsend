import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import ip from 'ip';

const app = express();
app.use(cors());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*", // 允许所有来源，方便开发
    methods: ["GET", "POST"]
  }
});

// 存储在线用户: socket.id -> { id, username, ip }
const users = new Map();

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // 用户加入
  socket.on('join', (data) => {
    // 兼容旧版本：如果 data 是字符串，则为 username
    const username = typeof data === 'string' ? data : data.username;
    const avatarColor = typeof data === 'object' ? data.avatarColor : null;

    // 检查是否有同名用户，如果有，则断开旧连接（顶号机制）
    for (const [id, user] of users.entries()) {
      if (user.username === username && id !== socket.id) {
        console.log(`Duplicate username ${username}, disconnecting old socket ${id}`);
        // 尝试断开旧的 socket 连接
        const oldSocket = io.sockets.sockets.get(id);
        if (oldSocket) {
          oldSocket.disconnect(true);
        }
        users.delete(id);
      }
    }

    const userInfo = {
      id: socket.id,
      username: username || `User-${socket.id.substr(0, 4)}`,
      avatarColor: avatarColor,
      ip: socket.handshake.address
    };
    users.set(socket.id, userInfo);
    
    // 广播更新后的用户列表
    io.emit('user-list', Array.from(users.values()));
    console.log(`User joined: ${userInfo.username} (${socket.id})`);
  });

  // 更新用户信息 (用户名或头像颜色)
  socket.on('update-user-info', (data) => {
    const user = users.get(socket.id);
    if (user) {
      // 如果尝试修改用户名，检查是否与其他用户冲突
      if (data.username && data.username !== user.username) {
        for (const [id, otherUser] of users.entries()) {
          if (otherUser.username === data.username && id !== socket.id) {
            // 发现冲突，通知当前用户修改失败（或者强制顶掉对方？这里选择顶掉对方，保持一致性）
            console.log(`Duplicate username ${data.username} in update, disconnecting old socket ${id}`);
            const oldSocket = io.sockets.sockets.get(id);
            if (oldSocket) {
              oldSocket.disconnect(true);
            }
            users.delete(id);
          }
        }
      }

      if (data.username) user.username = data.username;
      if (data.avatarColor) user.avatarColor = data.avatarColor;
      
      users.set(socket.id, user);
      io.emit('user-list', Array.from(users.values()));
      console.log(`User updated info: ${user.username} (${socket.id})`);
    }
  });

  // WebRTC 信令转发
  // data: { target: targetSocketId, ...payload }
  socket.on('offer', (data) => {
    socket.to(data.target).emit('offer', {
      sender: socket.id,
      sdp: data.sdp
    });
  });

  socket.on('answer', (data) => {
    socket.to(data.target).emit('answer', {
      sender: socket.id,
      sdp: data.sdp
    });
  });

  socket.on('ice-candidate', (data) => {
    socket.to(data.target).emit('ice-candidate', {
      sender: socket.id,
      candidate: data.candidate
    });
  });

  // 文字聊天
  socket.on('chat-message', (data) => {
    // data: { target: targetSocketId, message: string }
    // 如果 target 存在则是私聊，否则可能是群聊（这里主要实现点对点）
    if (data.target) {
      socket.to(data.target).emit('chat-message', {
        sender: socket.id,
        message: data.message,
        timestamp: new Date().toISOString()
      });
    } else {
      // 广播
      socket.broadcast.emit('chat-message', {
        sender: socket.id,
        message: data.message,
        timestamp: new Date().toISOString()
      });
    }
  });

  // 断开连接
  socket.on('disconnect', () => {
    users.delete(socket.id);
    io.emit('user-list', Array.from(users.values()));
    console.log('User disconnected:', socket.id);
  });
});

const PORT = 3000;
const localIp = ip.address();

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on:`);
  console.log(`- Local:   http://localhost:${PORT}`);
  console.log(`- Network: http://${localIp}:${PORT}`);
});
