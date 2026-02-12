import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import { Send, Paperclip, ArrowLeft, User, Monitor, File, Download, Edit2, Check } from 'lucide-react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

// 工具函数：合并类名
function cn(...inputs) {
  return twMerge(clsx(inputs));
}

// 颜色数组
const AVATAR_COLORS = [
  'bg-red-500', 'bg-orange-500', 'bg-amber-500', 'bg-yellow-500', 
  'bg-lime-500', 'bg-green-500', 'bg-emerald-500', 'bg-teal-500', 
  'bg-cyan-500', 'bg-sky-500', 'bg-blue-500', 'bg-indigo-500', 
  'bg-violet-500', 'bg-purple-500', 'bg-fuchsia-500', 'bg-pink-500', 
  'bg-rose-500'
];

// 根据用户名获取颜色
const getAvatarColor = (name) => {
  if (!name) return 'bg-gray-400';
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
  const initial = name ? name.charAt(0).toUpperCase() : '?';
  
  const sizeClasses = {
    sm: "w-8 h-8 text-sm",
    md: "w-10 h-10 text-base",
    lg: "w-12 h-12 text-lg",
    xl: "w-16 h-16 text-2xl"
  };

  return (
    <div className={cn(
      "rounded-full flex items-center justify-center text-white font-bold shadow-sm shrink-0 transition-colors",
      sizeClasses[size],
      avatarColor,
      className
    )}>
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
            selectedColor === color && "ring-2 ring-offset-2 ring-black"
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

export default function App() {
  const [socket, setSocket] = useState(null);
  const [myId, setMyId] = useState('');
  const [users, setUsers] = useState([]);
  const [username, setUsername] = useState(() => localStorage.getItem('username') || '');
  const [avatarColor, setAvatarColor] = useState(() => localStorage.getItem('avatarColor') || '');
  const [isEditingName, setIsEditingName] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [tempName, setTempName] = useState('');
  const [selectedUser, setSelectedUser] = useState(null);
  const [messages, setMessages] = useState({}); // { userId: [msg1, msg2] }
  const [unreadCounts, setUnreadCounts] = useState({}); // { userId: count }
  const [inputText, setInputText] = useState('');
  const [isMobileView, setIsMobileView] = useState(window.innerWidth < 768);

  // WebRTC Refs
  const peerConnections = useRef({}); // { userId: RTCPeerConnection }
  const dataChannels = useRef({}); // { userId: RTCDataChannel }
  const fileChunks = useRef({}); // { userId: [ArrayBuffer, ...] }
  const fileMeta = useRef({}); // { userId: { name, size, type, receivedSize } }
  const pendingCandidates = useRef({}); // { userId: [RTCIceCandidate, ...] }

  // Socket 初始化
  useEffect(() => {
    const newSocket = io(SERVER_URL);
    setSocket(newSocket);

    return () => {
      newSocket.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!socket) return;

    // 响应式处理
    const handleResize = () => setIsMobileView(window.innerWidth < 768);
    window.addEventListener('resize', handleResize);

    // Socket 事件监听
    socket.on('connect', () => {
      setMyId(socket.id);
      // 如果本地有用户名则使用，否则生成默认
      const initialName = username || `User-${socket.id.slice(0, 4)}`;
      const initialColor = avatarColor || getAvatarColor(initialName);
      
      if (!username) {
        setUsername(initialName);
        localStorage.setItem('username', initialName);
      }
      if (!avatarColor) {
        setAvatarColor(initialColor);
        localStorage.setItem('avatarColor', initialColor);
      }

      socket.emit('join', {
        username: initialName,
        avatarColor: initialColor
      });
    });

    socket.on('user-list', (userList) => {
      // 过滤掉自己 (确保 socket.id 存在)
      const currentId = socket.id;
      if (currentId) {
        setUsers(userList.filter(u => u.id !== currentId));
      } else {
        setUsers(userList);
      }
    });

    socket.on('chat-message', (data) => {
      addMessage(data.sender, {
        sender: 'them',
        type: 'text',
        content: data.message,
        timestamp: data.timestamp
      });
      
      // 如果不在当前聊天窗口，增加未读计数
      if (selectedUser?.id !== data.sender) {
        setUnreadCounts(prev => ({
          ...prev,
          [data.sender]: (prev[data.sender] || 0) + 1
        }));
        
        // 标题闪烁提醒
        document.title = `(${ (unreadCounts[data.sender] || 0) + 1 }) New Message - LocalSend`;
      }
    });

    // WebRTC 信令处理
    socket.on('offer', async ({ sender, sdp }) => {
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
        socket.emit('answer', { target: sender, sdp: answer });
      } catch (err) {
        console.error('Error handling offer:', err);
      }
    });

    socket.on('answer', async ({ sender, sdp }) => {
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
          console.error('Error handling answer:', err);
        }
      }
    });

    socket.on('ice-candidate', async ({ sender, candidate }) => {
      const pc = peerConnections.current[sender];
      if (pc) {
        if (pc.remoteDescription) {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } else {
          // 缓冲 Candidate
          if (!pendingCandidates.current[sender]) {
            pendingCandidates.current[sender] = [];
          }
          pendingCandidates.current[sender].push(new RTCIceCandidate(candidate));
        }
      }
    });

    return () => {
      window.removeEventListener('resize', handleResize);
      socket.off('connect');
      socket.off('user-list');
      socket.off('chat-message');
      socket.off('offer');
      socket.off('answer');
      socket.off('ice-candidate');
    };
  }, [socket]); // 依赖 socket

  if (!socket) return <div className="flex h-screen items-center justify-center text-gray-500">Connecting...</div>;

  const createPeerConnection = (targetId) => {
    if (peerConnections.current[targetId]) return peerConnections.current[targetId];

    const pc = new RTCPeerConnection({
      iceServers: [] // 仅使用局域网 Host Candidate，不使用 STUN
    });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('ice-candidate', { target: targetId, candidate: event.candidate });
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
      
      if (typeof data === 'string') {
        // 可能是文件元数据
        try {
          const meta = JSON.parse(data);
          if (meta.type === 'file-meta') {
            fileMeta.current[targetId] = { ...meta, receivedSize: 0 };
            fileChunks.current[targetId] = [];
            
            // 清理旧的状态消息
            removeInfoMessages(targetId);
            
            addMessage(targetId, {
              sender: 'them',
              type: 'info',
              content: `正在接收文件: ${meta.name} (${formatSize(meta.size)})`,
              timestamp: new Date().toISOString()
            });
          }
        } catch (e) {
          console.error('Failed to parse meta data', e);
        }
      } else {
        // 二进制数据 (文件块)
        if (!fileMeta.current[targetId]) return;
        
        const chunk = data;
        fileChunks.current[targetId].push(chunk);
        fileMeta.current[targetId].receivedSize += chunk.byteLength;
        
        const { name, size, receivedSize, fileType } = fileMeta.current[targetId];
        
        // 进度更新 (可选：这里可以优化为只在完成时或每隔一段时间更新 UI)
        if (receivedSize >= size) {
          // 文件接收完成
          const blob = new Blob(fileChunks.current[targetId], { type: fileType });
          const url = URL.createObjectURL(blob);
          
          // 接收完成后，清理 "正在接收" 的状态消息
          removeInfoMessages(targetId);
          
          addMessage(targetId, {
            sender: 'them',
            type: 'file',
            content: name,
            url: url,
            size: size,
            timestamp: new Date().toISOString()
          });
          
          // 清理
          fileChunks.current[targetId] = [];
          fileMeta.current[targetId] = null;
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
      socket.emit('offer', { target: targetId, sdp: offer });
    } else if (!dc) {
       // 这种情况理论上少见，通常伴随 PC 创建
       dc = pc.createDataChannel("file-transfer");
       setupDataChannel(targetId, dc);
    }

    // 等待 DataChannel 开启
    if (dc.readyState !== 'open') {
        addMessage(targetId, {
            sender: 'system',
            type: 'info',
            content: '正在建立连接，请稍候...',
            timestamp: new Date().toISOString()
        });
        await new Promise(resolve => {
            dc.onopen = () => {
                console.log('Channel opened late');
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

    if (dc.readyState !== 'open') {
         // 连接失败，先清理之前的消息，再显示失败
         removeInfoMessages(targetId);
         addMessage(targetId, {
            sender: 'system',
            type: 'error',
            content: '连接建立失败，请重试',
            timestamp: new Date().toISOString()
        });
        return;
    }

    // 连接已建立，清理可能存在的旧状态消息
    removeInfoMessages(targetId);
    
    // 发送中提示
    addMessage(targetId, {
        sender: 'system',
        type: 'info',
        content: `正在发送 ${file.name}...`,
        timestamp: new Date().toISOString()
    });

    // 发送元数据
    const meta = {
      type: 'file-meta',
      name: file.name,
      size: file.size,
      fileType: file.type
    };
    dc.send(JSON.stringify(meta));

    // 发送文件块
    const chunkSize = 16 * 1024; // 16KB
    const reader = new FileReader();
    let offset = 0;

    reader.onload = (e) => {
      dc.send(e.target.result);
      offset += e.target.result.byteLength;
      
      if (offset < file.size) {
        readSlice(offset);
      } else {
        // 发送完成，清理 "正在发送" 提示
        removeInfoMessages(targetId);
        
        addMessage(targetId, {
            sender: 'me',
            type: 'file',
            content: file.name,
            size: file.size,
            url: URL.createObjectURL(file), // 本地预览
            timestamp: new Date().toISOString()
        });
      }
    };

    const readSlice = (o) => {
      const slice = file.slice(o, o + chunkSize);
      reader.readAsArrayBuffer(slice);
    };

    readSlice(0);
  };

  const addMessage = (userId, msg) => {
    setMessages(prev => ({
      ...prev,
      [userId]: [...(prev[userId] || []), msg]
    }));
  };

  // 移除指定类型的消息 (用于清理 "正在连接"、"正在接收" 等临时状态)
  const removeInfoMessages = (userId) => {
    setMessages(prev => ({
      ...prev,
      [userId]: (prev[userId] || []).filter(msg => msg.type !== 'info')
    }));
  };

  const handleSelectUser = (user) => {
    setSelectedUser(user);
    // 清除未读计数
    setUnreadCounts(prev => {
      const newCounts = { ...prev };
      delete newCounts[user.id];
      return newCounts;
    });
    document.title = 'LocalSend';
  };

  const handleSendMessage = () => {
    if (!inputText.trim() || !selectedUser) return;
    
    socket.emit('chat-message', {
      target: selectedUser.id,
      message: inputText
    });

    addMessage(selectedUser.id, {
      sender: 'me',
      type: 'text',
      content: inputText,
      timestamp: new Date().toISOString()
    });

    setInputText('');
  };

  const handleFileSelect = (e) => {
    const file = e.target.files[0];
    if (file && selectedUser) {
      initiateFileTransfer(selectedUser.id, file);
    }
  };

  const formatSize = (bytes) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const handleUpdateUsername = () => {
    if (tempName.trim()) {
      setUsername(tempName);
      localStorage.setItem('username', tempName);
      
      // 如果没有自定义过颜色，且用户修改了名字，则更新颜色为新名字对应的颜色
      if (!localStorage.getItem('avatarColor')) {
         const newColor = getAvatarColor(tempName);
         setAvatarColor(newColor);
         socket.emit('update-user-info', { username: tempName, avatarColor: newColor });
      } else {
         socket.emit('update-user-info', { username: tempName });
      }
      
      setIsEditingName(false);
    }
  };

  const handleColorSelect = (color) => {
    setAvatarColor(color);
    localStorage.setItem('avatarColor', color);
    socket.emit('update-user-info', { avatarColor: color });
    setShowColorPicker(false);
  };

  // 渲染逻辑
  const showSidebar = !isMobileView || !selectedUser;
  const showChat = !isMobileView || selectedUser;

  return (
    <div className="flex h-[100dvh] bg-gray-100 overflow-hidden font-sans touch-manipulation">
      {/* Sidebar / User List */}
      <div className={cn(
        "bg-white border-r border-gray-200 flex flex-col transition-all duration-300",
        showSidebar ? "w-full md:w-80 translate-x-0" : "w-0 -translate-x-full md:translate-x-0 md:w-80 hidden md:flex"
      )}>
        <div className="p-4 border-b border-gray-100 bg-blue-600 text-white shadow-md z-10 safe-top">
          <div className="flex items-center gap-3">
             <div className="relative group">
                <div onClick={() => setShowColorPicker(!showColorPicker)} className="cursor-pointer">
                   <Avatar name={username} color={avatarColor} size="lg" className="border-2 border-white shadow-sm" />
                </div>
                {showColorPicker && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setShowColorPicker(false)}></div>
                    <ColorPicker selectedColor={avatarColor} onSelect={handleColorSelect} />
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
                    onKeyDown={(e) => e.key === 'Enter' && handleUpdateUsername()}
                    className="w-full bg-white/20 text-white placeholder-blue-200 text-sm rounded px-2 py-1 outline-none border border-blue-400 focus:border-white transition-colors"
                 />
                 <button onClick={handleUpdateUsername} className="p-1 hover:bg-white/20 rounded text-white transition-colors">
                   <Check size={16} />
                 </button>
               </div>
             ) : (
               <div className="flex-1 min-w-0 group cursor-pointer" onClick={() => { setTempName(username); setIsEditingName(true); }}>
                  <div className="flex items-center gap-2">
                    <h1 className="font-bold text-lg leading-tight truncate">{username}</h1>
                    <Edit2 size={14} className="opacity-0 group-hover:opacity-50 transition-opacity" />
                  </div>
                  <p className="text-xs text-blue-100 opacity-80">My ID: {myId?.slice(0,6)}...</p>
               </div>
             )}
          </div>
        </div>
        
        <div className="flex-1 overflow-y-auto p-2 scroll-smooth">
          {users.filter(u => u.id !== myId && u.id !== socket.id).length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-gray-400 p-8">
              <div className="w-16 h-16 bg-gray-50 rounded-full flex items-center justify-center mb-4">
                <User size={32} className="opacity-20" />
              </div>
              <p className="font-medium">局域网内暂无其他用户</p>
              <p className="text-sm mt-2 text-center opacity-70">请在同一 Wi-Fi 下的其他设备打开此页面</p>
            </div>
          ) : (
            users.filter(u => u.id !== myId && u.id !== socket.id).map(user => (
              <div
                key={user.id}
                onClick={() => handleSelectUser(user)}
                className={cn(
                  "flex items-center gap-4 p-4 rounded-xl cursor-pointer mb-2 transition-all active:scale-[0.98]",
                  selectedUser?.id === user.id ? "bg-blue-50 border border-blue-100 shadow-sm" : "bg-white hover:bg-gray-50 border border-transparent shadow-sm md:shadow-none"
                )}
              >
                <div className="relative">
                    <Avatar name={user.username} color={user.avatarColor} size="lg" className="border border-gray-100" />
                    <div className="absolute bottom-0 right-0 w-3 h-3 bg-green-500 border-2 border-white rounded-full"></div>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex justify-between items-center mb-1">
                      <h3 className="font-bold text-gray-800 truncate">{user.username}</h3>
                      {unreadCounts[user.id] > 0 && (
                        <span className="bg-red-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full min-w-[18px] text-center shadow-sm animate-bounce">
                          {unreadCounts[user.id] > 99 ? '99+' : unreadCounts[user.id]}
                        </span>
                      )}
                  </div>
                  <p className="text-xs text-gray-500 truncate font-mono bg-gray-100 inline-block px-1.5 py-0.5 rounded">{user.ip}</p>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Chat Area */}
      <div className={cn(
        "flex-1 flex flex-col bg-gray-50 transition-all duration-300 relative",
        showChat ? "translate-x-0" : "translate-x-full absolute right-0 w-full h-full md:relative md:translate-x-0"
      )}>
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
              <Avatar name={selectedUser.username} color={selectedUser.avatarColor} size="md" />
              <div className="flex-1 min-w-0">
                <h2 className="font-bold text-gray-800 truncate text-base">{selectedUser.username}</h2>
                <p className="text-xs text-green-600 flex items-center gap-1 font-medium">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span> Online
                </p>
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4 scroll-smooth pb-20 md:pb-4">
              {(messages[selectedUser.id] || []).map((msg, idx) => (
                <div key={idx} className={cn(
                  "flex animate-in fade-in slide-in-from-bottom-2 duration-300",
                  msg.sender === 'me' ? "justify-end" : "justify-start"
                )}>
                  <div className={cn(
                    "max-w-[85%] md:max-w-[70%] rounded-2xl p-3 shadow-sm break-words",
                    msg.sender === 'me' ? "bg-blue-600 text-white rounded-tr-sm" : "bg-white text-gray-800 border border-gray-100 rounded-tl-sm"
                  )}>
                    {msg.type === 'text' && <p className="leading-relaxed whitespace-pre-wrap">{msg.content}</p>}
                    {msg.type === 'file' && (
                      <div className="flex items-center gap-3 min-w-[200px]">
                        <div className={cn("p-2.5 rounded-xl", msg.sender === 'me' ? "bg-white/20" : "bg-gray-100")}>
                          <File size={24} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-bold text-sm truncate">{msg.content}</p>
                          <p className="text-xs opacity-80 mt-0.5">{formatSize(msg.size)}</p>
                        </div>
                        {msg.url && (
                            <a href={msg.url} download={msg.content} className={cn("p-2 rounded-full transition-colors", msg.sender === 'me' ? "hover:bg-white/20 active:bg-white/30" : "hover:bg-gray-100 active:bg-gray-200")}>
                                <Download size={20} />
                            </a>
                        )}
                      </div>
                    )}
                    {msg.type === 'info' && (
                        <div className="flex items-center gap-2 opacity-80">
                            <div className="w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin" />
                            <p className="text-xs italic">{msg.content}</p>
                        </div>
                    )}
                    <p className={cn("text-[10px] mt-1.5 text-right opacity-60 font-medium", msg.sender === 'me' ? "text-blue-100" : "text-gray-400")}>
                      {new Date(msg.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
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
                  <input type="file" className="hidden" onChange={handleFileSelect} />
                </label>
                <textarea
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          handleSendMessage();
                      }
                  }}
                  placeholder="发送消息..."
                  rows={1}
                  className="flex-1 bg-transparent border-none outline-none text-gray-800 placeholder-gray-400 py-2.5 min-h-[44px] max-h-32 resize-none"
                  style={{ height: 'auto' }}
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
              点击左侧用户列表<br/>开始极速传输
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
