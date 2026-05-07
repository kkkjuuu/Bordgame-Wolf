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

function getBalancedRoles(count) {
    let roles = [];
    // จัดบทบาทตามรูปที่ส่งมา: ผู้หยั่งรู้, บอดี้การ์ด, ชาวบ้าน, มนุษย์หมาป่า
    if (count == 4) roles = ["มนุษย์หมาป่า", "ผู้หยั่งรู้", "บอดี้การ์ด", "ชาวบ้าน"];
    else if (count == 5) roles = ["มนุษย์หมาป่า", "ผู้หยั่งรู้", "บอดี้การ์ด", "ชาวบ้าน", "ชาวบ้าน"];
    else if (count >= 6) {
        roles = ["มนุษย์หมาป่า", "มนุษย์หมาป่า", "ผู้หยั่งรู้", "บอดี้การ์ด", "ชาวบ้าน"];
        while (roles.length < count) roles.push("ชาวบ้าน");
    }
    return roles.sort(() => Math.random() - 0.5);
}

io.on('connection', (socket) => {
    socket.on('createRoom', ({ roomId, playerName, maxPlayers }) => {
        if (rooms[roomId]) return socket.emit('errorMsg', 'ห้องนี้มีอยู่แล้ว');
        socket.join(roomId);
        rooms[roomId] = {
            players: [{ id: socket.id, name: playerName, isHost: true, isAlive: true }],
            state: 'LOBBY',
            maxPlayers: parseInt(maxPlayers),
            nightActions: {},
            votes: {},
            timer: 0
        };
        io.to(roomId).emit('updateRoom', rooms[roomId]);
    });

    socket.on('joinRoom', ({ roomId, playerName }) => {
        const room = rooms[roomId];
        if (!room) return socket.emit('errorMsg', 'ไม่พบห้องนี้');
        if (room.players.length >= room.maxPlayers) return socket.emit('errorMsg', 'ห้องเต็มแล้ว');
        
        socket.join(roomId);
        room.players.push({ id: socket.id, name: playerName, isHost: false, isAlive: true });
        io.to(roomId).emit('updateRoom', room);
    });

    socket.on('startGame', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        const roles = getBalancedRoles(room.players.length);
        room.players.forEach((p, i) => p.role = roles[i]);
        room.state = 'STARTING'; // เริ่มนับถอยหลัง 3 วินาที
        io.to(roomId).emit('updateRoom', room);

        setTimeout(() => {
            room.state = 'ROLE_REVEAL';
            io.to(roomId).emit('updateRoom', room);
        }, 3500);
    });

    socket.on('nightAction', ({ roomId, targetId, actionType }) => {
        const room = rooms[roomId];
        if (!room) return;
        room.nightActions[actionType] = targetId;
        
        // ข้ามขั้นตอนถ้าครบ
        if (actionType === 'WOLF_KILL') {
            room.state = 'NIGHT_SHERIFF'; // (ในโค้ด UI คือ บอดี้การ์ด)
        } else if (actionType === 'BODYGUARD_PROTECT') {
            resolveNight(roomId);
        }
        io.to(roomId).emit('updateRoom', room);
    });

    function resolveNight(roomId) {
        const room = rooms[roomId];
        let victim = null;
        if (room.nightActions.WOLF_KILL !== room.nightActions.BODYGUARD_PROTECT) {
            victim = room.players.find(p => p.id === room.nightActions.WOLF_KILL);
            if (victim) victim.isAlive = false;
        }
        room.state = 'DAY_TIME';
        room.lastVictim = victim ? victim.name : null;
        io.to(roomId).emit('updateRoom', room);
        checkWin(roomId);
    }

    socket.on('startVoting', (roomId) => {
        const room = rooms[roomId];
        room.state = 'VOTING';
        room.votes = {};
        io.to(roomId).emit('updateRoom', room);

        // ระบบจับเวลาโหวต 10 วินาที
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
        let p = room.players.find(x => x.id === eliminatedId);
        if (p) p.isAlive = false;

        room.state = 'VOTE_RESULT';
        room.lastEliminated = p ? p.name : 'ไม่มีใคร';
        io.to(roomId).emit('updateRoom', room);
        
        setTimeout(() => {
            if (!checkWin(roomId)) {
                room.state = 'NIGHT_TIME';
                room.nightActions = {};
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
