const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const rooms = {};

// ส่งรายการห้องที่ "ยังไม่เริ่มเกม" ให้ทุกคน
function broadcastRooms() {
    const roomList = Object.keys(rooms).map(id => ({
        id: id,
        currentPlayers: rooms[id].players.length,
        maxPlayers: rooms[id].maxPlayers,
        hasPassword: rooms[id].password !== "",
        state: rooms[id].state
    })).filter(r => r.state === 'LOBBY');
    io.emit('roomListUpdate', roomList);
}

io.on('connection', (socket) => {
    // ส่งรายการห้องทันทีที่คนต่อเข้าเว็บ
    broadcastRooms();

    socket.on('createRoom', ({ roomId, playerName, maxPlayers, password }) => {
        if (rooms[roomId]) return socket.emit('errorMsg', 'ชื่อห้องนี้ซ้ำ');
        
        socket.join(roomId);
        rooms[roomId] = {
            players: [{ id: socket.id, name: playerName, isHost: true, isAlive: true }],
            state: 'LOBBY',
            maxPlayers: parseInt(maxPlayers),
            password: password || "",
            nightActions: {},
            votes: {}
        };
        socket.emit('joined', { roomId, isHost: true });
        broadcastRooms();
    });

    socket.on('joinRoom', ({ roomId, playerName, password }) => {
        const room = rooms[roomId];
        if (!room) return socket.emit('errorMsg', 'ไม่พบห้องนี้');
        if (room.password !== "" && room.password !== password) return socket.emit('errorMsg', 'รหัสผ่านไม่ถูกต้อง');
        if (room.players.length >= room.maxPlayers) return socket.emit('errorMsg', 'ห้องเต็มแล้ว');
        
        socket.join(roomId);
        room.players.push({ id: socket.id, name: playerName, isHost: false, isAlive: true });
        socket.emit('joined', { roomId, isHost: false });
        io.to(roomId).emit('updateRoom', room);
        broadcastRooms();
    });

    socket.on('startGame', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        
        // แก้บัค: ตรวจสอบความพร้อมและสุ่มบทบาท
        const roles = ["มนุษย์หมาป่า", "ผู้หยั่งรู้", "บอดี้การ์ด", "ชาวบ้าน", "ชาวบ้าน", "ชาวบ้าน"];
        const shuffled = roles.slice(0, room.players.length).sort(() => Math.random() - 0.5);
        
        room.players.forEach((p, i) => p.role = shuffled[i]);
        room.state = 'STARTING';
        io.to(roomId).emit('updateRoom', room);
        broadcastRooms();

        setTimeout(() => {
            room.state = 'ROLE_REVEAL';
            io.to(roomId).emit('updateRoom', room);
        }, 3500);
    });

    // ... (ส่วน NightAction, Vote, CheckWin เหมือนเดิมจากไฟล์ก่อนหน้า)
});

server.listen(process.env.PORT || 3000);
