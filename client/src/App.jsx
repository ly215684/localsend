import React, { useState, useEffect, useRef } from "react";
import { io } from "socket.io-client";
import {
  Send,
  Paperclip,
  ArrowLeft,
  User,
  Monitor,
  File,
  Download,
  Edit2,
  Check,
  Users,
  Plus,
  Hash,
  X,
} from "lucide-react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

// 工具函数：合并类名
function cn(...inputs) {
  return twMerge(clsx(inputs));
}

// 颜色数组
const AVATAR_COLORS = [
  "bg-red-500",
  "bg-orange-500",
  "bg-amber-500",
  "bg-yellow-500",
  "bg-lime-500",
  "bg-green-500",
  "bg-emerald-500",
  "bg-teal-500",
  "bg-cyan-500",
  "bg-sky-500",
  "bg-blue-500",
  "bg-indigo-500",
  "bg-violet-500",
  "bg-purple-500",
  "bg-fuchsia-500",
  "bg-pink-500",
  "bg-rose-500",
];

// 根据用户名获取颜色
const getAvatarColor = (name) => {
  if (!name) return "bg-gray-400";
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash) % AVATAR_COLORS.length;
  return AVATAR_COLORS[index];
};

// 头像组件
const Avatar = ({ name, color, size = "md", className }) => {
  const avatarColor = color || getAvatarColor(name);
  const initial = name ? name.charAt(0).toUpperCase() : "?";

  const sizeClasses = {
    sm: "w-8 h-8 text-sm",
    md: "w-10 h-10 text-base",
    lg: "w-12 h-12 text-lg",
    xl: "w-16 h-16 text-2xl",
  };

  return (
    <div
      className={cn(
        "rounded-full flex items-center justify-center text-white font-bold shadow-sm shrink-0 transition-colors",
        sizeClasses[size],
        avatarColor,
        className,
      )}
    >
      {initial}
    </div>
  );
};

// 颜色选择器组件
const ColorPicker = ({ selectedColor, onSelect }) => {
  return (
    <div className="grid grid-cols-6 gap-2 p-2 bg-white rounded-lg shadow-lg border border-gray-100 mt-2 absolute top-full left-0 z-50 w-64">
      {AVATAR_COLORS.map((color) => (
        <button
          key={color}
          className={cn(
            "w-8 h-8 rounded-full transition-transform hover:scale-110 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500",
            color,
            selectedColor === color && "ring-2 ring-offset-2 ring-black",
          )}
          onClick={() => onSelect(color)}
        />
      ))}
    </div>
  );
};

// 连接 Socket Server
// 注意：在实际局域网部署中，这里应该是服务器的局域网 IP
// 为了方便，默认尝试连接 window.location.hostname (如果前后端同源)
// 或者硬编码 localhost:3000
const SERVER_URL = `http://${window.location.hostname}:3000`;

const PUBLIC_ROOM_ID = "public-room";
const PUBLIC_ROOM_USER = {
  id: PUBLIC_ROOM_ID,
  username: "公共聊天室",
  avatarColor: "bg-blue-600",
  isPublic: true,
};

export default function App() {
  const [socket, setSocket] = useState(null);
  const [myId, setMyId] = useState("");
  const [users, setUsers] = useState([]);
  const [username, setUsername] = useState(
    () => localStorage.getItem("username") || "",
  );
  const [avatarColor, setAvatarColor] = useState(
    () => localStorage.getItem("avatarColor") || "",
  );
  const [isEditingName, setIsEditingName] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [tempName, setTempName] = useState("");

  // Custom Rooms
  const [customRooms, setCustomRooms] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("customRooms") || "[]");
    } catch {
      return [];
    }
  });
  const [isAddingRoom, setIsAddingRoom] = useState(false);
  const [roomInput, setRoomInput] = useState("");

  const [selectedUser, setSelectedUser] = useState(null);
  const [messages, setMessages] = useState({}); // { userId: [msg1, msg2] }
  const [unreadCounts, setUnreadCounts] = useState({}); // { userId: count }
  const [inputText, setInputText] = useState("");
  const [isMobileView, setIsMobileView] = useState(window.innerWidth < 768);

  // WebRTC Refs
  const peerConnections = useRef({}); // { userId: RTCPeerConnection }
  const dataChannels = useRef({}); // { userId: RTCDataChannel }
  const fileChunks = useRef({}); // { userId: [ArrayBuffer, ...] }
  const fileMeta = useRef({}); // { userId: { name, size, type, receivedSize } }
  const pendingCandidates = useRef({}); // { userId: [RTCIceCandidate, ...] }
  const fileTransferState = useRef({}); // { userId: { progress: number, cancelled: boolean, messageId: string } }

  useEffect(() => {
    localStorage.setItem("customRooms", JSON.stringify(customRooms));
    if (socket && socket.connected) {
      customRooms.forEach((room) => socket.emit("join-room", room.id));
    }
  }, [customRooms, socket]);

  // Socket Initialization
  useEffect(() => {
    // Use the same port as server (3000)
    const serverPort = 3000;
    const url =
      window.location.hostname === "localhost"
        ? `http://localhost:${serverPort}`
        : `http://${window.location.hostname}:${serverPort}`;

    const newSocket = io(url, {
      transports: ["websocket", "polling"],
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    });
    setSocket(newSocket);

    const onConnect = () => {
      console.log("Connected with ID:", newSocket.id);
      setMyId(newSocket.id);

      // 必须发送 'join' 事件，否则服务器不会将用户加入列表
      const currentName = username || `User-${newSocket.id.slice(0, 4)}`;
      const currentColor = avatarColor || getAvatarColor(currentName);

      // 如果没有本地用户名，初始化一个
      if (!username) {
        setUsername(currentName);
        localStorage.setItem("username", currentName);
      }
      if (!avatarColor) {
        setAvatarColor(currentColor);
        localStorage.setItem("avatarColor", currentColor);
      }

      newSocket.emit("join", {
        username: currentName,
        avatarColor: currentColor,
      });

      // Re-join custom rooms
      customRooms.forEach((room) => newSocket.emit("join-room", room.id));
    };

    newSocket.on("connect", onConnect);

    newSocket.on("user-list", (userList) => {
      setUsers(userList);
    });

    return () => {
      newSocket.disconnect();
    };
  }, []); // Only run once on mount

  useEffect(() => {
    if (!socket) return;

    // 响应式处理
    const handleResize = () => setIsMobileView(window.innerWidth < 768);
    window.addEventListener("resize", handleResize);

    socket.on("chat-message", (data) => {
      // 区分私聊、群聊和自定义聊天室
      const isPublic = data.sender === PUBLIC_ROOM_ID;
      const isRoom = data.isRoom;

      let targetId;
      if (isPublic) {
        targetId = PUBLIC_ROOM_ID;
      } else if (isRoom) {
        targetId = data.roomId;
      } else {
        targetId = data.sender;
      }

      const msg = {
        sender:
          isPublic || isRoom
            ? data.realSenderId === myId
              ? "me"
              : "them"
            : "them",
        realSenderName: data.realSenderName, // 群聊时显示真实用户名
        realSenderId: data.realSenderId,
        type: "text",
        content: data.message,
        timestamp: data.timestamp,
      };

      addMessage(targetId, msg);

      // 如果不在当前聊天窗口，增加未读计数
      if (selectedUser?.id !== targetId) {
        setUnreadCounts((prev) => ({
          ...prev,
          [targetId]: (prev[targetId] || 0) + 1,
        }));

        // 标题闪烁提醒
        document.title = `(${(unreadCounts[targetId] || 0) + 1}) 新消息 - LocalSend`;
      }
    });

    // WebRTC 信令处理
    socket.on("offer", async ({ sender, sdp }) => {
      const pc = createPeerConnection(sender);
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));

        // 处理缓冲的 Candidates
        if (pendingCandidates.current[sender]) {
          for (const candidate of pendingCandidates.current[sender]) {
            await pc.addIceCandidate(candidate);
          }
          delete pendingCandidates.current[sender];
        }

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit("answer", { target: sender, sdp: answer });
      } catch (err) {
        console.error("Error handling offer:", err);
      }
    });

    socket.on("answer", async ({ sender, sdp }) => {
      const pc = peerConnections.current[sender];
      if (pc) {
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(sdp));

          // 处理缓冲的 Candidates
          if (pendingCandidates.current[sender]) {
            for (const candidate of pendingCandidates.current[sender]) {
              await pc.addIceCandidate(candidate);
            }
            delete pendingCandidates.current[sender];
          }
        } catch (err) {
          console.error("Error handling answer:", err);
        }
      }
    });

    socket.on("ice-candidate", async ({ sender, candidate }) => {
      const pc = peerConnections.current[sender];
      if (pc) {
        if (pc.remoteDescription) {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } else {
          // 缓冲 Candidate
          if (!pendingCandidates.current[sender]) {
            pendingCandidates.current[sender] = [];
          }
          pendingCandidates.current[sender].push(
            new RTCIceCandidate(candidate),
          );
        }
      }
    });

    return () => {
      window.removeEventListener("resize", handleResize);
      socket.off("connect");
      socket.off("user-list");
      socket.off("chat-message");
      socket.off("offer");
      socket.off("answer");
      socket.off("ice-candidate");
    };
  }, [socket]); // 依赖 socket

  if (!socket)
    return (
      <div className="flex h-screen items-center justify-center text-gray-500">
        正在连接...
      </div>
    );

  const createPeerConnection = (targetId) => {
    if (peerConnections.current[targetId])
      return peerConnections.current[targetId];

    const pc = new RTCPeerConnection({
      iceServers: [], // 仅使用局域网 Host Candidate，不使用 STUN
    });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit("ice-candidate", {
          target: targetId,
          candidate: event.candidate,
        });
      }
    };

    pc.ondatachannel = (event) => {
      setupDataChannel(targetId, event.channel);
    };

    peerConnections.current[targetId] = pc;
    return pc;
  };

  const setupDataChannel = (targetId, channel) => {
    dataChannels.current[targetId] = channel;

    channel.onopen = () => console.log(`Data channel with ${targetId} opened`);
    channel.onclose = () => console.log(`Data channel with ${targetId} closed`);

    channel.onmessage = (event) => {
      const data = event.data;

      if (typeof data === "string") {
        // 可能是文件元数据
        try {
          const meta = JSON.parse(data);
          if (meta.type === "file-meta") {
            fileMeta.current[targetId] = { ...meta, receivedSize: 0 };
            fileChunks.current[targetId] = [];

            // 清理旧的状态消息
            removeInfoMessages(targetId);

            const messageId = `receiving-${Date.now()}`;

            // 创建接收方的传输状态
            fileTransferState.current[targetId] = {
              progress: 0,
              cancelled: false,
              messageId: messageId,
            };

            addMessage(targetId, {
              sender: "them",
              type: "receiving",
              content: meta.name,
              size: meta.size,
              progress: 0,
              messageId: messageId,
              timestamp: new Date().toISOString(),
            });
          }
        } catch (e) {
          console.error("Failed to parse meta data", e);
        }
      } else {
        // 二进制数据 (文件块)
        if (!fileMeta.current[targetId]) return;

        const chunk = data;
        fileChunks.current[targetId].push(chunk);
        fileMeta.current[targetId].receivedSize += chunk.byteLength;

        const { name, size, receivedSize, fileType } =
          fileMeta.current[targetId];
        const transferState = fileTransferState.current[targetId];

        // 更新进度
        const progress = Math.round((receivedSize / size) * 100);
        if (transferState) {
          transferState.progress = progress;
          updateReceivingProgress(targetId, transferState.messageId, progress);
        }

        // 文件接收完成
        if (receivedSize >= size) {
          const blob = new Blob(fileChunks.current[targetId], {
            type: fileType,
          });
          const url = URL.createObjectURL(blob);

          // 接收完成后，删除进度消息并添加文件消息
          const receivingMessageId = transferState?.messageId;
          if (receivingMessageId) {
            setMessages((prev) => {
              const msgs = prev[targetId] || [];
              const newMsgs = msgs.filter(
                (msg) => msg.messageId !== receivingMessageId,
              );
              return {
                ...prev,
                [targetId]: newMsgs,
              };
            });
          }

          addMessage(targetId, {
            sender: "them",
            type: "file",
            content: name,
            url: url,
            size: size,
            timestamp: new Date().toISOString(),
          });

          // 清理
          fileChunks.current[targetId] = [];
          fileMeta.current[targetId] = null;
          delete fileTransferState.current[targetId];
        }
      }
    };
  };

  const initiateFileTransfer = async (targetId, file) => {
    let pc = peerConnections.current[targetId];
    let dc = dataChannels.current[targetId];

    if (!pc) {
      pc = createPeerConnection(targetId);
      dc = pc.createDataChannel("file-transfer");
      setupDataChannel(targetId, dc);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit("offer", { target: targetId, sdp: offer });
    } else if (!dc) {
      // 这种情况理论上少见，通常伴随 PC 创建
      dc = pc.createDataChannel("file-transfer");
      setupDataChannel(targetId, dc);
    }

    // 等待 DataChannel 开启
    if (dc.readyState !== "open") {
      addMessage(targetId, {
        sender: "system",
        type: "info",
        content: "正在建立连接，请稍候...",
        timestamp: new Date().toISOString(),
      });
      await new Promise((resolve) => {
        dc.onopen = () => {
          console.log("Channel opened late");
          // 连接成功，移除 "正在建立连接" 消息
          removeInfoMessages(targetId);
          resolve();
        };
        // 简单的超时处理
        setTimeout(() => {
          resolve();
        }, 5000);
      });
    }

    if (dc.readyState !== "open") {
      // 连接失败，先清理之前的消息，再显示失败
      removeInfoMessages(targetId);
      addMessage(targetId, {
        sender: "system",
        type: "error",
        content: "连接建立失败，请重试",
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // 连接已建立，清理可能存在的旧状态消息
    removeInfoMessages(targetId);

    // 创建消息 ID 用于追踪
    const messageId = `sending-${Date.now()}`;

    // 初始化传输状态
    fileTransferState.current[targetId] = {
      progress: 0,
      cancelled: false,
      messageId: messageId,
    };

    // 发送中提示（带进度条）
    addMessage(targetId, {
      sender: "me",
      type: "sending",
      content: file.name,
      size: file.size,
      progress: 0,
      messageId: messageId,
      timestamp: new Date().toISOString(),
    });

    // 发送元数据
    const meta = {
      type: "file-meta",
      name: file.name,
      size: file.size,
      fileType: file.type,
    };
    dc.send(JSON.stringify(meta));

    // 发送文件块 - 使用并发发送和流量控制
    const chunkSize = 128 * 1024; // 128KB
    const MAX_BUFFERED_AMOUNT = 2 * 1024 * 1024; // 2MB 缓冲区上限
    const MAX_CONCURRENT_READS = 8; // 最多同时读取 8 个块
    let offset = 0;
    let activeReads = 0;
    let completed = false;

    const checkCompletion = () => {
      if (completed) return;
      if (offset >= file.size && activeReads === 0) {
        completed = true;
        // 发送完成，删除进度消息并添加文件消息
        setMessages((prev) => {
          const msgs = prev[targetId] || [];
          const newMsgs = msgs.filter((msg) => msg.messageId !== messageId);
          return {
            ...prev,
            [targetId]: newMsgs,
          };
        });

        addMessage(targetId, {
          sender: "me",
          type: "file",
          content: file.name,
          size: file.size,
          url: URL.createObjectURL(file), // 本地预览
          timestamp: new Date().toISOString(),
        });

        // 清理传输状态
        delete fileTransferState.current[targetId];
      }
    };

    const sendChunk = (chunkOffset) => {
      // 检查是否已取消
      if (fileTransferState.current[targetId]?.cancelled) {
        if (!completed) {
          completed = true;
          removeInfoMessages(targetId);
          addMessage(targetId, {
            sender: "system",
            type: "error",
            content: "文件发送已取消",
            timestamp: new Date().toISOString(),
          });
          delete fileTransferState.current[targetId];
        }
        return;
      }

      // 检查缓冲区，如果数据堆积则等待
      if (dc.bufferedAmount > MAX_BUFFERED_AMOUNT) {
        setTimeout(() => sendChunk(chunkOffset), 10);
        return;
      }

      // 读取文件块
      const slice = file.slice(
        chunkOffset,
        Math.min(chunkOffset + chunkSize, file.size),
      );
      const reader = new FileReader();

      reader.onload = (e) => {
        dc.send(e.target.result);
        const newOffset = chunkOffset + e.target.result.byteLength;

        // 更新进度（使用原子操作）
        const currentOffset = Math.max(offset, newOffset);
        offset = currentOffset;
        const progress = Math.round((currentOffset / file.size) * 100);
        fileTransferState.current[targetId].progress = progress;

        // 更新 UI 进度
        updateMessageProgress(targetId, messageId, progress);

        // 减少活跃读取数
        activeReads--;

        // 检查是否完成
        checkCompletion();

        // 如果还有数据要发送，启动新的读取
        if (offset < file.size) {
          scheduleNextChunk();
        }
      };

      reader.onerror = () => {
        activeReads--;
        console.error("Failed to read file chunk at offset:", chunkOffset);
        // 即使读取失败也尝试继续
        if (offset < file.size) {
          scheduleNextChunk();
        }
      };

      activeReads++;
      reader.readAsArrayBuffer(slice);
    };

    const scheduleNextChunk = () => {
      // 检查是否已取消
      if (fileTransferState.current[targetId]?.cancelled) return;

      // 如果达到并发上限或没有更多数据，等待
      if (activeReads >= MAX_CONCURRENT_READS || offset >= file.size) return;

      // 获取下一个偏移量
      const chunkOffset = offset;
      offset += chunkSize;

      // 发送下一个块
      sendChunk(chunkOffset);
    };

    // 启动初始的并发读取
    for (let i = 0; i < MAX_CONCURRENT_READS; i++) {
      scheduleNextChunk();
    }
  };

  const cancelFileTransfer = (targetId) => {
    const transferState = fileTransferState.current[targetId];
    if (transferState) {
      transferState.cancelled = true;

      // 关闭 data channel 以停止传输
      const dc = dataChannels.current[targetId];
      if (dc) {
        dc.close();
      }

      // 清理连接
      const pc = peerConnections.current[targetId];
      if (pc) {
        pc.close();
        delete peerConnections.current[targetId];
        delete dataChannels.current[targetId];
      }

      // 移除发送中的消息
      removeInfoMessages(targetId);

      addMessage(targetId, {
        sender: "system",
        type: "error",
        content: "文件发送已取消",
        timestamp: new Date().toISOString(),
      });

      delete fileTransferState.current[targetId];
    }
  };

  const updateMessageProgress = (targetId, messageId, progress) => {
    setMessages((prev) => {
      const msgs = prev[targetId] || [];
      const newMsgs = msgs.map((msg) => {
        if (msg.messageId === messageId && msg.type === "sending") {
          return { ...msg, progress };
        }
        return msg;
      });
      return {
        ...prev,
        [targetId]: newMsgs,
      };
    });
  };

  const updateReceivingProgress = (targetId, messageId, progress) => {
    setMessages((prev) => {
      const msgs = prev[targetId] || [];
      const newMsgs = msgs.map((msg) => {
        if (msg.messageId === messageId && msg.type === "receiving") {
          return { ...msg, progress };
        }
        return msg;
      });
      return {
        ...prev,
        [targetId]: newMsgs,
      };
    });
  };

  const addMessage = (userId, msg) => {
    setMessages((prev) => ({
      ...prev,
      [userId]: [...(prev[userId] || []), msg],
    }));
  };

  // 移除指定类型的消息 (用于清理 "正在连接"、"正在接收" 等临时状态)
  const removeInfoMessages = (userId) => {
    setMessages((prev) => ({
      ...prev,
      [userId]: (prev[userId] || []).filter((msg) => msg.type !== "info"),
    }));
  };

  const handleSelectUser = (user) => {
    setSelectedUser(user);
    // 清除未读计数
    setUnreadCounts((prev) => {
      const newCounts = { ...prev };
      delete newCounts[user.id];
      return newCounts;
    });
    document.title = "LocalSend";
  };

  const handleSendMessage = () => {
    if (!inputText.trim() || !selectedUser) return;

    // 如果是自定义聊天室
    if (selectedUser.isCustomRoom) {
      socket.emit("chat-message", {
        target: selectedUser.id,
        message: inputText,
        isRoom: true,
      });
    } else {
      socket.emit("chat-message", {
        target: selectedUser.id,
        message: inputText,
      });
    }

    // 如果是群聊或自定义聊天室，不用在这里手动添加消息，因为服务器会广播回所有
    // 修正：服务器 index.js 中 io.emit('chat-message', ...sender: 'public-room')
    // 前端收到 sender: 'public-room' 且 realSenderId === myId 时，标记为 'me'。
    // 所以群聊不需要在这里手动 addMessage，否则会重复。

    if (selectedUser.id !== PUBLIC_ROOM_ID && !selectedUser.isCustomRoom) {
      addMessage(selectedUser.id, {
        sender: "me",
        type: "text",
        content: inputText,
        timestamp: new Date().toISOString(),
      });
    }

    setInputText("");
  };

  const handleAddRoom = () => {
    if (!roomInput.trim()) return;
    const roomId = roomInput.trim();

    if (customRooms.some((r) => r.id === roomId)) {
      alert("你已加入该房间");
      return;
    }

    const newRoom = {
      id: roomId,
      username: `房间: ${roomId}`,
      avatarColor: getAvatarColor(roomId),
      isCustomRoom: true,
    };

    setCustomRooms((prev) => [...prev, newRoom]);
    setRoomInput("");
    setIsAddingRoom(false);
  };

  const handleLeaveRoom = (roomId, e) => {
    e.stopPropagation(); // Prevent selection
    setCustomRooms((prev) => prev.filter((r) => r.id !== roomId));
    socket.emit("leave-room", roomId);
    if (selectedUser?.id === roomId) {
      setSelectedUser(null);
    }
  };

  const handleFileSelect = (e) => {
    const file = e.target.files[0];
    if (file && selectedUser) {
      initiateFileTransfer(selectedUser.id, file);
    }
  };

  const formatSize = (bytes) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  const formatFileName = (name, maxLength = 20) => {
    if (name.length <= maxLength) return name;
    const extIndex = name.lastIndexOf(".");
    if (extIndex === -1) {
      return name.slice(0, maxLength - 3) + "...";
    }
    const ext = name.slice(extIndex);
    const baseName = name.slice(0, extIndex);
    const maxBaseLen = maxLength - ext.length - 3;
    if (maxBaseLen <= 0) return "..." + ext;
    return baseName.slice(0, maxBaseLen) + "..." + ext;
  };

  const handleUpdateUsername = () => {
    if (tempName.trim()) {
      setUsername(tempName);
      localStorage.setItem("username", tempName);

      // 如果没有自定义过颜色，且用户修改了名字，则更新颜色为新名字对应的颜色
      if (!localStorage.getItem("avatarColor")) {
        const newColor = getAvatarColor(tempName);
        setAvatarColor(newColor);
        socket.emit("update-user-info", {
          username: tempName,
          avatarColor: newColor,
        });
      } else {
        socket.emit("update-user-info", { username: tempName });
      }

      setIsEditingName(false);
    }
  };

  const handleColorSelect = (color) => {
    setAvatarColor(color);
    localStorage.setItem("avatarColor", color);
    socket.emit("update-user-info", { avatarColor: color });
    setShowColorPicker(false);
  };

  // 渲染逻辑
  const showSidebar = !isMobileView || !selectedUser;
  const showChat = !isMobileView || selectedUser;

  return (
    <div className="flex h-[100dvh] bg-gray-100 overflow-hidden font-sans touch-manipulation">
      {/* Sidebar / User List */}
      <div
        className={cn(
          "bg-white border-r border-gray-200 flex flex-col transition-all duration-300",
          showSidebar
            ? "w-full md:w-80 translate-x-0"
            : "w-0 -translate-x-full md:translate-x-0 md:w-80 hidden md:flex",
        )}
      >
        <div className="p-4 border-b border-gray-100 bg-blue-600 text-white shadow-md z-10 safe-top">
          <div className="flex items-center gap-3">
            <div className="relative group">
              <div
                onClick={() => setShowColorPicker(!showColorPicker)}
                className="cursor-pointer"
              >
                <Avatar
                  name={username}
                  color={avatarColor}
                  size="lg"
                  className="border-2 border-white shadow-sm"
                />
              </div>
              {showColorPicker && (
                <>
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => setShowColorPicker(false)}
                  ></div>
                  <ColorPicker
                    selectedColor={avatarColor}
                    onSelect={handleColorSelect}
                  />
                </>
              )}
              <button
                className="absolute bottom-0 right-0 w-6 h-6 bg-white text-blue-600 rounded-full flex items-center justify-center shadow-sm opacity-0 group-hover:opacity-100 transition-opacity md:opacity-0 opacity-100"
                onClick={() => {
                  setTempName(username);
                  setIsEditingName(true);
                }}
              >
                <Edit2 size={12} />
              </button>
            </div>

            {isEditingName ? (
              <div className="flex-1 flex items-center gap-2 animate-in fade-in zoom-in-95 duration-200">
                <input
                  autoFocus
                  value={tempName}
                  onChange={(e) => setTempName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleUpdateUsername()}
                  className="w-full bg-white/20 text-white placeholder-blue-200 text-sm rounded px-2 py-1 outline-none border border-blue-400 focus:border-white transition-colors"
                />
                <button
                  onClick={handleUpdateUsername}
                  className="p-1 hover:bg-white/20 rounded text-white transition-colors"
                >
                  <Check size={16} />
                </button>
              </div>
            ) : (
              <div
                className="flex-1 min-w-0 group cursor-pointer"
                onClick={() => {
                  setTempName(username);
                  setIsEditingName(true);
                }}
              >
                <div className="flex items-center gap-2">
                  <h1 className="font-bold text-lg leading-tight truncate">
                    {username}
                  </h1>
                  <Edit2
                    size={14}
                    className="opacity-0 group-hover:opacity-50 transition-opacity"
                  />
                </div>
                <p className="text-xs text-blue-100 opacity-80">
                  我的 ID: {myId?.slice(0, 6)}...
                </p>
              </div>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2 scroll-smooth">
          {/* 公共聊天室入口 */}
          <div
            onClick={() => handleSelectUser(PUBLIC_ROOM_USER)}
            className={cn(
              "flex items-center gap-4 p-4 rounded-xl cursor-pointer mb-2 transition-all active:scale-[0.98]",
              selectedUser?.id === PUBLIC_ROOM_ID
                ? "bg-blue-50 border border-blue-100 shadow-sm"
                : "bg-white hover:bg-gray-50 border border-transparent shadow-sm md:shadow-none",
            )}
          >
            <div className="relative">
              <div className="w-12 h-12 rounded-full flex items-center justify-center bg-blue-100 text-blue-600 border border-blue-200">
                <Users size={24} />
              </div>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex justify-between items-center mb-1">
                <h3 className="font-bold text-gray-800 truncate">公共聊天室</h3>
                {unreadCounts[PUBLIC_ROOM_ID] > 0 && (
                  <span className="bg-red-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full min-w-[18px] text-center shadow-sm animate-bounce">
                    {unreadCounts[PUBLIC_ROOM_ID] > 99
                      ? "99+"
                      : unreadCounts[PUBLIC_ROOM_ID]}
                  </span>
                )}
              </div>
              <p className="text-xs text-gray-500 truncate">所有人可见</p>
            </div>
          </div>

          <div className="h-px bg-gray-100 mx-4 my-2"></div>

          {/* Custom Rooms Section */}
          <div className="px-4 mb-2 flex items-center justify-between group">
            <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider">
              聊天室
            </h3>
            <button
              onClick={() => setIsAddingRoom(true)}
              className="p-1 text-gray-400 hover:text-blue-600 rounded transition-colors"
              title="加入房间"
            >
              <Plus size={14} />
            </button>
          </div>

          {isAddingRoom && (
            <div className="mx-4 mb-2 p-2 bg-gray-50 rounded border border-blue-200 animate-in fade-in slide-in-from-top-2">
              <div className="flex gap-2">
                <input
                  autoFocus
                  value={roomInput}
                  onChange={(e) => setRoomInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAddRoom()}
                  placeholder="输入房间号..."
                  className="flex-1 text-xs p-1.5 rounded border border-gray-200 outline-none focus:border-blue-400"
                />
                <button
                  onClick={handleAddRoom}
                  className="p-1.5 bg-blue-600 text-white rounded hover:bg-blue-700"
                >
                  <Check size={12} />
                </button>
                <button
                  onClick={() => setIsAddingRoom(false)}
                  className="p-1.5 bg-gray-200 text-gray-600 rounded hover:bg-gray-300"
                >
                  <Users size={12} className="rotate-45" />
                </button>
              </div>
            </div>
          )}

          {customRooms.map((room) => (
            <div
              key={room.id}
              onClick={() => handleSelectUser(room)}
              className={cn(
                "flex items-center gap-4 p-4 rounded-xl cursor-pointer mb-2 transition-all active:scale-[0.98] group relative",
                selectedUser?.id === room.id
                  ? "bg-blue-50 border border-blue-100 shadow-sm"
                  : "bg-white hover:bg-gray-50 border border-transparent shadow-sm md:shadow-none",
              )}
            >
              <div className="relative">
                <div className="w-12 h-12 rounded-full flex items-center justify-center bg-indigo-100 text-indigo-600 border border-indigo-200">
                  <Hash size={24} />
                </div>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex justify-between items-center mb-1">
                  <h3 className="font-bold text-gray-800 truncate">
                    {room.username}
                  </h3>
                  {unreadCounts[room.id] > 0 && (
                    <span className="bg-red-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full min-w-[18px] text-center shadow-sm animate-bounce">
                      {unreadCounts[room.id] > 99
                        ? "99+"
                        : unreadCounts[room.id]}
                    </span>
                  )}
                </div>
                <p className="text-xs text-gray-500 truncate">自定义房间</p>
              </div>
              <button
                onClick={(e) => handleLeaveRoom(room.id, e)}
                className="absolute right-2 top-2 p-1 text-gray-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                title="退出房间"
              >
                <Users size={14} className="rotate-45" />
              </button>
            </div>
          ))}

          <div className="h-px bg-gray-100 mx-4 my-2"></div>

          <div className="px-4 mb-2">
            <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider">
              在线用户
            </h3>
          </div>

          {users.filter((u) => u.id !== myId && u.id !== socket.id).length ===
          0 ? (
            <div className="flex flex-col items-center justify-center h-full text-gray-400 p-8">
              <div className="w-16 h-16 bg-gray-50 rounded-full flex items-center justify-center mb-4">
                <User size={32} className="opacity-20" />
              </div>
              <p className="font-medium">局域网内暂无其他用户</p>
              <p className="text-sm mt-2 text-center opacity-70">
                请在同一 Wi-Fi 下的其他设备打开此页面
              </p>
            </div>
          ) : (
            users
              .filter((u) => u.id !== myId && u.id !== socket.id)
              .map((user) => (
                <div
                  key={user.id}
                  onClick={() => handleSelectUser(user)}
                  className={cn(
                    "flex items-center gap-4 p-4 rounded-xl cursor-pointer mb-2 transition-all active:scale-[0.98]",
                    selectedUser?.id === user.id
                      ? "bg-blue-50 border border-blue-100 shadow-sm"
                      : "bg-white hover:bg-gray-50 border border-transparent shadow-sm md:shadow-none",
                  )}
                >
                  <div className="relative">
                    <Avatar
                      name={user.username}
                      color={user.avatarColor}
                      size="lg"
                      className="border border-gray-100"
                    />
                    <div className="absolute bottom-0 right-0 w-3 h-3 bg-green-500 border-2 border-white rounded-full"></div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex justify-between items-center mb-1">
                      <h3 className="font-bold text-gray-800 truncate">
                        {user.username}
                      </h3>
                      {unreadCounts[user.id] > 0 && (
                        <span className="bg-red-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full min-w-[18px] text-center shadow-sm animate-bounce">
                          {unreadCounts[user.id] > 99
                            ? "99+"
                            : unreadCounts[user.id]}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 truncate font-mono bg-gray-100 inline-block px-1.5 py-0.5 rounded">
                      {user.ip}
                    </p>
                  </div>
                </div>
              ))
          )}
        </div>
      </div>

      {/* Chat Area */}
      <div
        className={cn(
          "flex-1 flex flex-col bg-gray-50 transition-all duration-300 relative",
          showChat
            ? "translate-x-0"
            : "translate-x-full absolute right-0 w-full h-full md:relative md:translate-x-0",
        )}
      >
        {selectedUser ? (
          <>
            {/* Chat Header */}
            <div className="h-16 px-4 border-b border-gray-200 bg-white/90 backdrop-blur-sm flex items-center gap-3 shadow-sm z-20 sticky top-0 safe-top">
              {isMobileView && (
                <button
                  onClick={() => setSelectedUser(null)}
                  className="p-2 -ml-2 text-gray-600 active:bg-gray-100 rounded-full transition-colors"
                >
                  <ArrowLeft size={24} />
                </button>
              )}
              {selectedUser.id === PUBLIC_ROOM_ID ? (
                <div className="w-10 h-10 rounded-full flex items-center justify-center bg-blue-100 text-blue-600 border border-blue-200">
                  <Users size={20} />
                </div>
              ) : selectedUser.isCustomRoom ? (
                <div className="w-10 h-10 rounded-full flex items-center justify-center bg-indigo-100 text-indigo-600 border border-indigo-200">
                  <Hash size={20} />
                </div>
              ) : (
                <Avatar
                  name={selectedUser.username}
                  color={selectedUser.avatarColor}
                  size="md"
                />
              )}
              <div className="flex-1 min-w-0">
                <h2 className="font-bold text-gray-800 truncate text-base">
                  {selectedUser.username}
                </h2>
                {selectedUser.id === PUBLIC_ROOM_ID ? (
                  <p className="text-xs text-blue-500 font-medium">公共频道</p>
                ) : selectedUser.isCustomRoom ? (
                  <p className="text-xs text-indigo-500 font-medium">
                    房间号: {selectedUser.id}
                  </p>
                ) : (
                  <p className="text-xs text-green-600 flex items-center gap-1 font-medium">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span>{" "}
                    在线
                  </p>
                )}
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4 scroll-smooth pb-20 md:pb-4">
              {(messages[selectedUser.id] || []).map((msg, idx) => (
                <div
                  key={idx}
                  className={cn(
                    "flex animate-in fade-in slide-in-from-bottom-2 duration-300",
                    msg.sender === "me" ? "justify-end" : "justify-start",
                  )}
                >
                  <div
                    className={cn(
                      "max-w-[85%] md:max-w-[70%] rounded-2xl p-3 shadow-sm break-words",
                      msg.sender === "me"
                        ? "bg-blue-600 text-white rounded-tr-sm"
                        : "bg-white text-gray-800 border border-gray-100 rounded-tl-sm",
                    )}
                  >
                    {msg.type === "text" && (
                      <div className="flex flex-col">
                        {(selectedUser.id === PUBLIC_ROOM_ID ||
                          selectedUser.isCustomRoom) &&
                          msg.sender !== "me" && (
                            <span className="text-[10px] text-gray-500 font-bold mb-1 opacity-75">
                              {msg.realSenderName || "未知用户"}
                            </span>
                          )}
                        <p className="leading-relaxed whitespace-pre-wrap">
                          {msg.content}
                        </p>
                      </div>
                    )}
                    {msg.type === "file" && (
                      <div className="flex items-center gap-3 min-w-[200px]">
                        <div
                          className={cn(
                            "p-2.5 rounded-xl",
                            msg.sender === "me" ? "bg-white/20" : "bg-gray-100",
                          )}
                        >
                          <File size={24} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p
                            className="font-bold text-sm truncate"
                            title={msg.content}
                          >
                            {formatFileName(msg.content)}
                          </p>
                          <p className="text-xs opacity-80 mt-0.5">
                            {formatSize(msg.size)}
                          </p>
                        </div>
                        {msg.url && (
                          <a
                            href={msg.url}
                            download={msg.content}
                            className={cn(
                              "p-2 rounded-full transition-colors",
                              msg.sender === "me"
                                ? "hover:bg-white/20 active:bg-white/30"
                                : "hover:bg-gray-100 active:bg-gray-200",
                            )}
                          >
                            <Download size={20} />
                          </a>
                        )}
                      </div>
                    )}
                    {msg.type === "info" && (
                      <div className="flex items-center gap-2 opacity-80">
                        <div className="w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin" />
                        <p className="text-xs italic">{msg.content}</p>
                      </div>
                    )}
                    {msg.type === "sending" && (
                      <div className="flex flex-col gap-2 min-w-[250px]">
                        <div className="flex items-center gap-3">
                          <div
                            className={cn(
                              "p-2.5 rounded-xl",
                              msg.sender === "me"
                                ? "bg-white/20"
                                : "bg-gray-100",
                            )}
                          >
                            <File size={24} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p
                              className="font-bold text-sm truncate"
                              title={msg.content}
                            >
                              {formatFileName(msg.content)}
                            </p>
                            <p className="text-xs opacity-80 mt-0.5">
                              {formatSize(msg.size)}
                            </p>
                          </div>
                          {msg.sender === "me" && (
                            <button
                              onClick={() =>
                                cancelFileTransfer(selectedUser.id)
                              }
                              className={cn(
                                "p-2 rounded-full transition-colors hover:bg-red-500/20 active:scale-90",
                              )}
                              title="取消发送"
                            >
                              <X size={18} />
                            </button>
                          )}
                        </div>
                        <div className="relative h-1.5 bg-black/20 rounded-full overflow-hidden">
                          <div
                            className="absolute left-0 top-0 h-full bg-current rounded-full transition-all duration-300"
                            style={{ width: `${msg.progress}%` }}
                          />
                        </div>
                        <p className="text-xs opacity-80">{msg.progress}%</p>
                      </div>
                    )}
                    {msg.type === "receiving" && (
                      <div className="flex flex-col gap-2 min-w-[250px]">
                        <div className="flex items-center gap-3">
                          <div
                            className={cn(
                              "p-2.5 rounded-xl",
                              msg.sender === "me"
                                ? "bg-white/20"
                                : "bg-gray-100",
                            )}
                          >
                            <File size={24} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p
                              className="font-bold text-sm truncate"
                              title={msg.content}
                            >
                              {formatFileName(msg.content)}
                            </p>
                            <p className="text-xs opacity-80 mt-0.5">
                              {formatSize(msg.size)}
                            </p>
                          </div>
                        </div>
                        <div className="relative h-1.5 bg-black/20 rounded-full overflow-hidden">
                          <div
                            className="absolute left-0 top-0 h-full bg-current rounded-full transition-all duration-300"
                            style={{ width: `${msg.progress}%` }}
                          />
                        </div>
                        <p className="text-xs opacity-80">{msg.progress}%</p>
                      </div>
                    )}
                    <p
                      className={cn(
                        "text-[10px] mt-1.5 text-right opacity-60 font-medium",
                        msg.sender === "me" ? "text-blue-100" : "text-gray-400",
                      )}
                    >
                      {new Date(msg.timestamp).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </p>
                  </div>
                </div>
              ))}
            </div>

            {/* Input Area */}
            <div className="p-3 md:p-4 bg-white border-t border-gray-200 sticky bottom-0 safe-bottom z-20">
              <div className="flex items-end gap-2 bg-gray-100 p-2 rounded-2xl border border-transparent focus-within:border-blue-500 focus-within:bg-white focus-within:ring-2 focus-within:ring-blue-100 transition-all">
                <label className="p-2.5 text-gray-500 hover:text-blue-600 active:scale-90 transition-transform cursor-pointer">
                  <Paperclip size={22} />
                  <input
                    type="file"
                    className="hidden"
                    onChange={handleFileSelect}
                  />
                </label>
                <textarea
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSendMessage();
                    }
                  }}
                  placeholder="发送消息..."
                  rows={1}
                  className="flex-1 bg-transparent border-none outline-none text-gray-800 placeholder-gray-400 py-2.5 min-h-[44px] max-h-32 resize-none"
                  style={{ height: "auto" }}
                />
                <button
                  onClick={handleSendMessage}
                  disabled={!inputText.trim()}
                  className="p-2.5 bg-blue-600 text-white rounded-xl hover:bg-blue-700 active:scale-95 disabled:opacity-50 disabled:active:scale-100 disabled:cursor-not-allowed transition-all shadow-sm"
                >
                  <Send size={20} />
                </button>
              </div>
            </div>
          </>
        ) : (
          /* Empty State */
          <div className="flex-1 flex flex-col items-center justify-center text-gray-300 p-8 animate-in fade-in duration-500">
            <div className="w-32 h-32 bg-gray-100 rounded-full flex items-center justify-center mb-6 shadow-inner">
              <Monitor size={64} className="text-gray-300" />
            </div>
            <p className="text-xl font-bold text-gray-500">LocalSend</p>
            <p className="text-base mt-2 text-gray-400 max-w-xs text-center leading-relaxed">
              点击左侧用户列表
              <br />
              开始极速传输
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
