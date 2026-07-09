const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // 允许所有来源（开发阶段）
    methods: ["GET", "POST"]
  }
});

// ============ 房间管理 ============
const rooms = new Map();

// ============ 静态文件服务（可选） ============
// 如果你想用后端托管前端文件，取消下面的注释
// app.use(express.static(path.join(__dirname, '../frontend')));

// ============ API 路由 ============
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: '赛博游戏厅联机服务器运行中',
    version: '1.0.0'
  });
});

app.get('/api/rooms', (req, res) => {
  // 返回活跃房间列表（不包含已开始的游戏）
  const activeRooms = [];
  rooms.forEach((room, roomId) => {
    if (room.players.length < 2 && !room.gameStarted) {
      activeRooms.push({
        roomId: roomId,
        playerCount: room.players.length,
        hostName: room.players[0]?.name || '未知'
      });
    }
  });
  res.json(activeRooms);
});

// ============ Socket.IO 事件处理 ============
io.on('connection', (socket) => {
  console.log(`🎮 新玩家连接: ${socket.id}`);

  // ---------- 创建房间 ----------
  socket.on('create_room', (data, callback) => {
    try {
      const playerName = data.playerName || `玩家${Math.floor(Math.random() * 1000)}`;
      const roomId = generateRoomId();
      
      const room = {
        id: roomId,
        host: socket.id,
        players: [{
          id: socket.id,
          name: playerName,
          ready: false,
          isHost: true
        }],
        gameState: null,
        gameStarted: false,
        createdAt: Date.now(),
        currentTurn: null // 用于轮流制游戏
      };
      
      rooms.set(roomId, room);
      socket.join(roomId);
      
      console.log(`🏠 房间 ${roomId} 创建成功 - 房主: ${playerName}`);
      
      // 回调返回结果
      if (callback) {
        callback({
          success: true,
          roomId: roomId,
          player: room.players[0]
        });
      }
      
      // 通知房间内玩家
      io.to(roomId).emit('room_update', {
        roomId: roomId,
        players: room.players,
        gameStarted: false
      });
      
    } catch (error) {
      console.error('创建房间失败:', error);
      if (callback) {
        callback({ success: false, error: '创建房间失败' });
      }
    }
  });

  // ---------- 加入房间 ----------
  socket.on('join_room', (data, callback) => {
    try {
      const { roomId, playerName } = data;
      const room = rooms.get(roomId);
      
      if (!room) {
        if (callback) callback({ success: false, error: '房间不存在' });
        return;
      }
      
      if (room.players.length >= 2) {
        if (callback) callback({ success: false, error: '房间已满' });
        return;
      }
      
      if (room.gameStarted) {
        if (callback) callback({ success: false, error: '游戏已经开始' });
        return;
      }
      
      const newPlayer = {
        id: socket.id,
        name: playerName || `玩家${Math.floor(Math.random() * 1000)}`,
        ready: false,
        isHost: false
      };
      
      room.players.push(newPlayer);
      socket.join(roomId);
      
      console.log(`🚪 玩家 ${newPlayer.name} 加入房间 ${roomId}`);
      
      if (callback) {
        callback({
          success: true,
          roomId: roomId,
          player: newPlayer
        });
      }
      
      // 通知房间内所有玩家
      io.to(roomId).emit('room_update', {
        roomId: roomId,
        players: room.players,
        gameStarted: false
      });
      
      // 如果满员，自动开始游戏
      if (room.players.length === 2) {
        startGame(roomId);
      }
      
    } catch (error) {
      console.error('加入房间失败:', error);
      if (callback) {
        callback({ success: false, error: '加入房间失败' });
      }
    }
  });

  // ---------- 玩家准备 ----------
  socket.on('player_ready', (data) => {
    const room = findRoomByPlayerId(socket.id);
    if (!room) return;
    
    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      player.ready = !player.ready;
      
      io.to(room.id).emit('room_update', {
        roomId: room.id,
        players: room.players,
        gameStarted: false
      });
      
      // 检查是否所有人都准备好了
      if (room.players.length === 2 && room.players.every(p => p.ready)) {
        startGame(room.id);
      }
    }
  });

  // ---------- 游戏操作 ----------
  socket.on('game_action', (data) => {
    const room = findRoomByPlayerId(socket.id);
    if (!room) return;
    
    // 验证是否是当前玩家的回合（轮流制游戏）
    if (room.currentTurn && room.currentTurn !== socket.id) {
      socket.emit('error', '还没到你的回合');
      return;
    }
    
    // 广播给房间内其他玩家
    socket.to(room.id).emit('game_sync', {
      playerId: socket.id,
      action: data.action,
      timestamp: Date.now()
    });
    
    // 切换回合（如果是轮流制）
    if (room.currentTurn) {
      const nextPlayer = room.players.find(p => p.id !== socket.id);
      if (nextPlayer) {
        room.currentTurn = nextPlayer.id;
        io.to(room.id).emit('turn_change', {
          playerId: nextPlayer.id,
          playerName: nextPlayer.name
        });
      }
    }
  });

  // ---------- 游戏结束 ----------
  socket.on('game_over', (data) => {
    const room = findRoomByPlayerId(socket.id);
    if (!room) return;
    
    io.to(room.id).emit('game_result', {
      winner: data.winner,
      scores: data.scores,
      reason: data.reason || '游戏结束'
    });
    
    // 清理房间（延迟删除，让玩家看到结果）
    setTimeout(() => {
      rooms.delete(room.id);
      console.log(`🧹 房间 ${room.id} 已清理`);
    }, 5000);
  });

  // ---------- 断开连接 ----------
  socket.on('disconnect', () => {
    console.log(`❌ 玩家断开连接: ${socket.id}`);
    
    // 查找玩家所在的房间
    rooms.forEach((room, roomId) => {
      const playerIndex = room.players.findIndex(p => p.id === socket.id);
      
      if (playerIndex !== -1) {
        const playerName = room.players[playerIndex].name;
        
        if (room.players.length === 1) {
          // 房间里只剩一个人，删除房间
          rooms.delete(roomId);
          console.log(`🧹 房间 ${roomId} 已删除（玩家全部离开）`);
        } else {
          // 通知另一个玩家
          room.players.splice(playerIndex, 1);
          io.to(roomId).emit('player_left', {
            playerId: socket.id,
            playerName: playerName
          });
          
          // 如果游戏正在进行，结束游戏
          if (room.gameStarted) {
            io.to(roomId).emit('game_result', {
              winner: room.players[0]?.id,
              reason: `${playerName} 离开了游戏`
            });
            rooms.delete(roomId);
          }
        }
      }
    });
  });
});

// ============ 辅助函数 ============

// 生成房间号（6位大写字母数字组合）
function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// 根据玩家ID查找房间
function findRoomByPlayerId(playerId) {
  for (const [roomId, room] of rooms) {
    if (room.players.some(p => p.id === playerId)) {
      return room;
    }
  }
  return null;
}

// 开始游戏
function startGame(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  room.gameStarted = true;
  
  // 随机决定先手
  const firstPlayer = room.players[Math.floor(Math.random() * room.players.length)];
  room.currentTurn = firstPlayer.id;
  
  console.log(`🎮 游戏开始 - 房间 ${roomId} - 先手: ${firstPlayer.name}`);
  
  // 通知所有玩家
  io.to(roomId).emit('game_start', {
    roomId: roomId,
    players: room.players,
    firstPlayer: {
      id: firstPlayer.id,
      name: firstPlayer.name
    },
    settings: {
      boardSize: 15, // 五子棋棋盘大小
      timeLimit: 30 // 每步时间限制（秒）
    }
  });
}

// ============ 启动服务器 ============
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('╔═══════════════════════════════════╗');
  console.log('║   赛博游戏厅联机服务器 v1.0.0     ║');
  console.log('╠═══════════════════════════════════╣');
  console.log(`║  地址: http://localhost:${PORT}      ║`);
  console.log('║  状态: 运行中                      ║');
  console.log('╚═══════════════════════════════════╝');
});
