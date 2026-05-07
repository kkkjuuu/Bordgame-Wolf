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

// ฟังก์ชันส่งรายการห้องให้ทุกคน
function broadcastRooms() {
    const roomList = Object.keys(rooms).map(id => ({
        id: id,
        currentPlayers: rooms[id].players.length,
        maxPlayers: rooms[id].maxPlayers,
        hasPassword: rooms[id].password !== "",
        state: rooms[id].state
    })).filter(r => r.state === 'LOBBY'); // โชว์เฉพาะห้องที่ยังไม่เริ่ม
    io.emit('roomListUpdate', roomList);
}

io.on('connection', (socket) => {
    // ส่งรายการห้องทันทีที่คนเปิดหน้าเว็บ
    broadcastRooms();

    socket.on('createRoom', ({ roomId, playerName, maxPlayers, password }) => {
        if (rooms[roomId]) return socket.emit('errorMsg', 'ชื่อห้องนี้ซ้ำ');
        socket.join(roomId);
        rooms[roomId] = {
            players: [{ id: socket.id, name: playerName, isHost: true, isAlive: true, isReady: false }],
            state: 'LOBBY',
            maxPlayers: parseInt(maxPlayers),
            password: password || "",
            nightActions: {},
            votes: {},
            readyCount: 0
        };
        socket.emit('joined', { roomId, isHost: true });
        broadcastRooms(); // อัปเดตรายการห้องให้เพื่อนเห็นทันที
    });

    socket.on('joinRoom', ({ roomId, playerName, password }) => {
        const room = rooms[roomId];
        if (!room) return socket.emit('errorMsg', 'ไม่พบห้องนี้');
        if (room.password !== "" && room.password !== password) return socket.emit('errorMsg', 'รหัสผ่านผิด');
        
        socket.join(roomId);
        room.players.push({ id: socket.id, name: playerName, isHost: false, isAlive: true, isReady: false });
        socket.emit('joined', { roomId, isHost: false });
        io.to(roomId).emit('updateRoom', room);
        broadcastRooms(); // อัปเดตจำนวนคนในห้องให้เพื่อนข้างนอกเห็น
    });

    socket.on('startGame', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        const roles = ["มนุษย์หมาป่า", "ผู้หยั่งรู้", "บอดี้การ์ด", "ชาวบ้าน", "ชาวบ้าน", "ชาวบ้าน"];
        const shuffled = roles.slice(0, room.players.length).sort(() => Math.random() - 0.5);
        room.players.forEach((p, i) => {
            p.role = shuffled[i];
            p.isReady = false;
            p.isAlive = true;
        });
        room.state = 'STARTING';
        io.to(roomId).emit('updateRoom', room);
        broadcastRooms(); // เอาห้องออกจากรายการเพราะเริ่มเล่นแล้ว
        
        setTimeout(() => {
            room.state = 'ROLE_REVEAL';
            io.to(roomId).emit('updateRoom', room);
        }, 4000);
    });

    socket.on('playerReady', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        const p = room.players.find(x => x.id === socket.id);
        if (p) {
            p.isReady = true;
            const alive = room.players.filter(x => x.isAlive);
            const ready = alive.filter(x => x.isReady);
            io.to(roomId).emit('updateRoom', room);

            if (ready.length === alive.length) {
                setTimeout(() => {
                    room.players.forEach(x => x.isReady = false);
                    room.state = 'NIGHT_WOLF';
                    io.to(roomId).emit('updateRoom', room);
                }, 1000);
            }
        }
    });

    socket.on('disconnect', () => {
        // ล้างห้องถ้าไม่มีคนอยู่ (Optional)
    });
});

server.listen(process.env.PORT || 3000);
