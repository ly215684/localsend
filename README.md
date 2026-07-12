# LocalSend - 局域网文件互传与聊天工具

LocalSend 是一个仿 QQ 风格的局域网即时通讯与文件传输工具。它允许在同一局域网内的设备之间进行点对点（P2P）的高速文件传输和即时文字聊天，无需连接外网。

## ✨ 主要功能

*   **📁 极速文件传输**: 基于 WebRTC 技术，实现局域网内设备点对点直连传输，速度极快，不消耗流量。
    *   **支持多文件上传**: 可同时选择多个文件进行批量传输，文件会按顺序依次发送。
    *   实时进度显示：每个文件都有独立的传输进度条。
*   **💬 即时通讯**: 支持一对一私聊、公共频道广播以及自定义房间群聊。
*   **📱 响应式设计**: 完美适配桌面端和移动端，针对手机浏览器进行了专门优化（支持 PWA 风格体验）。
*   **🎨 个性化定制**:
    *   支持自定义用户名。
    *   自动生成基于名字的文字头像。
    *   支持自定义头像背景颜色。
*   **🔒 隐私安全**: 数据仅在局域网内传输，不经过外部服务器。
*   **🚀 稳定可靠**:
    *   支持断线重连。
    *   支持多设备同时在线（自动处理重名顶号）。
    *   未读消息红点提醒与浏览器标题闪烁。

## 🛠️ 技术栈

*   **前端 (Client)**:
    *   React 18
    *   Vite
    *   Tailwind CSS (UI 样式)
    *   Socket.io-client (信令与聊天)
    *   WebRTC (文件传输)
    *   Lucide React (图标)
*   **后端 (Server)**:
    *   Node.js
    *   Express
    *   Socket.io (WebSocket 服务)

## 🚀 快速开始

### 环境要求

*   [Node.js](https://nodejs.org/) (建议 v16+)
*   npm 或 yarn

### 1. 启动后端服务 (Server)

后端负责信令交换和用户管理。

```bash
cd server
npm install
npm run start
```

服务器默认运行在 `http://localhost:3000` (同时也会显示局域网 IP)。

### 2. 启动前端应用 (Client)

前端提供用户界面。

```bash
cd client
npm install
npm run dev
```

前端默认运行在 `http://localhost:5173`。

### 3. 局域网访问

1.  确保电脑和手机连接在**同一个 Wi-Fi** 下。
2.  查看后端启动时的控制台输出，找到 `Network` 地址（例如 `http://192.168.1.5:3000`）。
3.  **注意**：前端代码中已配置为自动连接到 `window.location.hostname:3000`。
    *   **开发模式**：你需要让手机访问前端的开发服务器 IP（例如 `http://192.168.1.5:5173`）。
    *   **重要**：确保你的防火墙允许 Node.js 进程通过，或者暂时关闭防火墙。

## 📂 项目结构

```
localsend/
├── client/              # 前端 React 项目
│   ├── src/
│   │   ├── App.jsx      # 核心应用逻辑
│   │   └── index.css    # Tailwind 样式入口
│   ├── vite.config.js   # Vite 配置
│   └── package.json
├── server/              # 后端 Node.js 项目
│   ├── index.js         # Socket.io 服务器入口
│   └── package.json
└── README.md            # 项目说明文档
```

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 许可证

MIT License
