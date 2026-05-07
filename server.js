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
    broadcastRooms();

    socket.on('createRoom', ({ roomId, playerName, maxPlayers, password }) => {
        if (rooms[roomId]) return socket.emit('errorMsg', 'ชื่อห้องนี้ซ้ำ');
        socket.join(roomId);
        rooms[roomId] = {
            players: [{ id: socket.id, name: playerName, isHost: true, isAlive: true, isReady: false }],
            state: 'LOBBY',
            maxPlayers: parseInt(maxPlayers),
            password: password || "",
            nightActions: { WOLF_KILL: null, GUARD_PROTECT: null },
            lastGuarded: {}, // เก็บไอดีที่บอดี้การ์ดเคยป้องกันรอบที่แล้ว
            votes: {},
            readyCount: 0
        };
        socket.emit('joined', { roomId, isHost: true });
        broadcastRooms();
    });

    socket.on('joinRoom', ({ roomId, playerName, password }) => {
        const room = rooms[roomId];
        if (!room) return socket.emit('errorMsg', 'ไม่พบห้อง');
        if (room.password !== "" && room.password !== password) return socket.emit('errorMsg', 'รหัสผ่านผิด');
        socket.join(roomId);
        room.players.push({ id: socket.id, name: playerName, isHost: false, isAlive: true, isReady: false });
        socket.emit('joined', { roomId, isHost: false });
        io.to(roomId).emit('updateRoom', room);
        broadcastRooms();
    });

    socket.on('startGame', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        // ปรับสมดุลตามคำขอ: 4 คน = หมาป่า 1, หยั่งรู้ 1, บอดี้การ์ด 1, ชาวบ้าน 1
        let roles = ["มนุษย์หมาป่า", "ผู้หยั่งรู้", "บอดี้การ์ด", "ชาวบ้าน"];
        if (room.players.length > 4) {
            const extra = Array(room.players.length - 4).fill("ชาวบ้าน");
            roles = roles.concat(extra);
        }
        const shuffled = roles.sort(() => Math.random() - 0.5);
        room.players.forEach((p, i) => {
            p.role = shuffled[i];
            p.isReady = false;
            p.isAlive = true;
        });
        room.state = 'STARTING';
        io.to(roomId).emit('updateRoom', room);
        broadcastRooms();

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
                    room.state = 'NIGHT_WOLF'; // เริ่มคืนด้วยหมาป่า
                    room.nightActions = { WOLF_KILL: null, GUARD_PROTECT: null };
                    io.to(roomId).emit('updateRoom', room);
                }, 1000);
            }
        }
    });

    socket.on('nightAction', ({ roomId, targetId, actionType }) => {
        const room = rooms[roomId];
        if (!room) return;

        if (actionType === 'WOLF_KILL') {
            room.nightActions.WOLF_KILL = targetId;
            room.state = 'NIGHT_SEER'; // หมาป่าฆ่าเสร็จ -> ผู้หยั่งรู้ตรวจ
        } else if (actionType === 'SEER_CHECK') {
            const target = room.players.find(x => x.id === targetId);
            const result = target.role === 'มนุษย์หมาป่า' ? 'คนร้าย' : 'คนดี';
            socket.emit('seerResult', { name: target.name, result: result });
            room.state = 'NIGHT_BODYGUARD'; // ตรวจเสร็จ -> บอดี้การ์ดป้องกัน
        } else if (actionType === 'GUARD_PROTECT') {
            room.nightActions.GUARD_PROTECT = targetId;
            room.lastGuarded[socket.id] = targetId; // บันทึกว่ารอบนี้กันใคร
            resolveNight(roomId);
        }
        io.to(roomId).emit('updateRoom', room);
    });

    function resolveNight(roomId) {
        const room = rooms[roomId];
        let victim = null;
        // ถ้าหมาป่าฆ่าคนที่ไม่ถูกบอดี้การ์ดป้องกัน
        if (room.nightActions.WOLF_KILL && room.nightActions.WOLF_KILL !== room.nightActions.GUARD_PROTECT) {
            const p = room.players.find(x => x.id === room.nightActions.WOLF_KILL);
            if (p) { p.isAlive = false; victim = p.name; }
        }
        room.state = 'DAY_TIME';
        room.lastVictim = victim;
        io.to(roomId).emit('updateRoom', room);
        checkGameOver(roomId);
    }

    function checkGameOver(roomId) {
        const room = rooms[roomId];
        const wolves = room.players.filter(p => p.role === 'มนุษย์หมาป่า' && p.isAlive);
        const villagers = room.players.filter(p => p.role !== 'มนุษย์hมาป่า' && p.isAlive);
        
        if (wolves.length === 0) {
            room.state = 'GAME_OVER'; room.winner = 'VILLAGERS';
        } else if (wolves.length >= villagers.length) {
            room.state = 'GAME_OVER'; room.winner = 'WOLVES';
        }
        io.to(roomId).emit('updateRoom', room);
    }

    // ระบบโหวต
    socket.on('startVoting', (roomId) => {
        const room = rooms[roomId];
        room.state = 'VOTING';
        io.to(roomId).emit('updateRoom', room);
        let time = 10;
        const timer = setInterval(() => {
            time--;
            io.to(roomId).emit('timerUpdate', time);
            if (time <= 0) {
                clearInterval(timer);
                resolveVote(roomId);
            }
        }, 1000);
    });

    function resolveVote(roomId) {
        const room = rooms[roomId];
        // ... (Logic โหวตเหมือนเดิม) ...
        room.state = 'DAY_TIME'; // หรือกลับไป ROLE_REVEAL เพื่อกดพร้อมรอบใหม่
        io.to(roomId).emit('updateRoom', room);
        checkGameOver(roomId);
    }
});

server.listen(process.env.PORT || 3000);
