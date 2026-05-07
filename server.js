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
            nightActions: { WOLF_KILL: null, BODYGUARD_PROTECT: null },
            votes: {},
            readyCount: 0
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
        room.players.push({ id: socket.id, name: playerName, isHost: false, isAlive: true, isReady: false });
        socket.emit('joined', { roomId, isHost: false });
        io.to(roomId).emit('updateRoom', room);
        broadcastRooms();
    });

    // แก้ไขจุดนี้: เมื่อคนกด "เริ่มเกม" (Host)
    socket.on('startGame', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        
        const rolesList = ["มนุษย์หมาป่า", "ผู้หยั่งรู้", "บอดี้การ์ด", "ชาวบ้าน", "ชาวบ้าน", "ชาวบ้าน"];
        const shuffled = rolesList.slice(0, room.players.length).sort(() => Math.random() - 0.5);
        
        room.players.forEach((p, i) => {
            p.role = shuffled[i];
            p.isAlive = true;
            p.isReady = false;
        });
        
        room.state = 'STARTING';
        room.readyCount = 0;
        io.to(roomId).emit('updateRoom', room);
        broadcastRooms();

        setTimeout(() => {
            room.state = 'ROLE_REVEAL';
            io.to(roomId).emit('updateRoom', room);
        }, 4000);
    });

    // แก้ไขจุดนี้: เมื่อผู้เล่นกด "พร้อมแล้ว" หลังจากดูบทบาท
    socket.on('playerReady', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (player && !player.isReady) {
            player.isReady = true;
            room.readyCount++;
            
            io.to(roomId).emit('updateRoom', room);

            // ตรวจสอบว่าทุกคนที่ยังรอดชีวิต กดพร้อมครบหรือยัง
            const alivePlayers = room.players.filter(p => p.isAlive).length;
            if (room.readyCount >= alivePlayers) {
                room.readyCount = 0;
                room.players.forEach(p => p.isReady = false);
                startNight(roomId);
            }
        }
    });

    function startNight(roomId) {
        const room = rooms[roomId];
        if (!room) return;
        room.state = 'NIGHT_WOLF';
        room.nightActions = { WOLF_KILL: null, BODYGUARD_PROTECT: null };
        io.to(roomId).emit('updateRoom', room);
    }

    socket.on('nightAction', ({ roomId, targetId, actionType }) => {
        const room = rooms[roomId];
        if (!room) return;

        if (actionType === 'WOLF_KILL') {
            room.nightActions.WOLF_KILL = targetId;
            // หลังจากหมาป่าเลือกเสร็จ ให้ขยับไปที่สเต็ปบอดี้การ์ด
            room.state = 'NIGHT_BODYGUARD';
            
            // ตรวจสอบว่ามีบอดี้การ์ดที่ยังมีชีวิตอยู่ไหม ถ้าไม่มีให้ข้ามไปเช้าเลย
            const hasGuard = room.players.find(p => p.role === 'บอดี้การ์ด' && p.isAlive);
            if (!hasGuard) {
                setTimeout(() => resolveNight(roomId), 2000);
            }
        } else if (actionType === 'BODYGUARD_PROTECT') {
            room.nightActions.BODYGUARD_PROTECT = targetId;
            resolveNight(roomId);
        }
        io.to(roomId).emit('updateRoom', room);
    });

    function resolveNight(roomId) {
        const room = rooms[roomId];
        let victimName = null;

        if (room.nightActions.WOLF_KILL && room.nightActions.WOLF_KILL !== room.nightActions.BODYGUARD_PROTECT) {
            const victim = room.players.find(p => p.id === room.nightActions.WOLF_KILL);
            if (victim) {
                victim.isAlive = false;
                victimName = victim.name;
            }
        }

        room.state = 'DAY_TIME';
        room.lastVictim = victimName;
        room.readyCount = 0;
        io.to(roomId).emit('updateRoom', room);
        checkWin(roomId);
    }

    socket.on('startVoting', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        room.state = 'VOTING';
        room.votes = {};
        io.to(roomId).emit('updateRoom', room);

        let timeLeft = 10;
        const timer = setInterval(() => {
            timeLeft--;
            io.to(roomId).emit('timerUpdate', timeLeft);
            if (timeLeft <= 0) {
                clearInterval(timer);
                resolveVote(roomId);
            }
        }, 1000);
    });

    socket.on('castVote', ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (room && room.state === 'VOTING') {
            room.votes[socket.id] = targetId;
        }
    });

    function resolveVote(roomId) {
        const room = rooms[roomId];
        if (!room) return;

        const counts = {};
        Object.values(room.votes).forEach(id => counts[id] = (counts[id] || 0) + 1);
        
        let eliminatedId = Object.keys(counts).reduce((a, b) => counts[a] > counts[b] ? a : b, null);
        if (eliminatedId) {
            const p = room.players.find(x => x.id === eliminatedId);
            if (p) {
                p.isAlive = false;
                room.lastEliminated = p.name;
            }
        } else {
            room.lastEliminated = "ไม่มีใคร";
        }

        room.state = 'VOTE_RESULT';
        io.to(roomId).emit('updateRoom', room);
        
        setTimeout(() => {
            if (!checkWin(roomId)) {
                room.state = 'ROLE_REVEAL'; // วนกลับไปหน้ากดพร้อมเพื่อเข้ากลางคืนใหม่
                room.readyCount = 0;
                room.players.forEach(p => p.isReady = false);
                io.to(roomId).emit('updateRoom', room);
            }
        }, 5000);
    }

    function checkWin(roomId) {
        const room = rooms[roomId];
        const wolves = room.players.filter(p => p.role === 'มนุษย์หมาป่า' && p.isAlive);
        const villagers = room.players.filter(p => p.role !== 'มนุษย์หมาป่า' && p.isAlive);

        if (wolves.length === 0) {
            room.state = 'GAME_OVER';
            room.winner = 'VILLAGERS';
            io.to(roomId).emit('updateRoom', room);
            return true;
        } else if (wolves.length >= villagers.length) {
            room.state = 'GAME_OVER';
            room.winner = 'WOLVES';
            io.to(roomId).emit('updateRoom', room);
            return true;
        }
        return false;
    }
});

server.listen(process.env.PORT || 3000);
