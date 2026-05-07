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

io.on('connection', (socket) => {
    socket.on('createRoom', ({ roomId, playerName, maxPlayers, password }) => {
        socket.join(roomId);
        rooms[roomId] = {
            players: [{ id: socket.id, name: playerName, isHost: true, isAlive: true, isReady: false }],
            state: 'LOBBY',
            maxPlayers: parseInt(maxPlayers),
            password: password || "",
            nightActions: {},
            votes: {}
        };
        socket.emit('joined', { roomId, isHost: true });
    });

    socket.on('joinRoom', ({ roomId, playerName, password }) => {
        const room = rooms[roomId];
        if (!room) return socket.emit('errorMsg', 'ไม่พบห้อง');
        socket.join(roomId);
        room.players.push({ id: socket.id, name: playerName, isHost: false, isAlive: true, isReady: false });
        socket.emit('joined', { roomId, isHost: false });
        io.to(roomId).emit('updateRoom', room);
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
        
        setTimeout(() => {
            room.state = 'ROLE_REVEAL';
            io.to(roomId).emit('updateRoom', room);
        }, 4000);
    });

    socket.on('playerReady', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            player.isReady = true;
            const alivePlayers = room.players.filter(p => p.isAlive);
            const readyPlayers = alivePlayers.filter(p => p.isReady);

            io.to(roomId).emit('updateRoom', room);

            if (readyPlayers.length === alivePlayers.length) {
                setTimeout(() => {
                    room.players.forEach(p => p.isReady = false);
                    room.state = 'NIGHT_WOLF';
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
            room.state = 'NIGHT_BODYGUARD';
            const hasGuard = room.players.find(p => p.role === 'บอดี้การ์ด' && p.isAlive);
            if (!hasGuard) setTimeout(() => resolveNight(roomId), 2000);
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
            if (victim) { victim.isAlive = false; victimName = victim.name; }
        }
        room.state = 'DAY_TIME';
        room.lastVictim = victimName;
        io.to(roomId).emit('updateRoom', room);
    }

    socket.on('startVoting', (roomId) => {
        const room = rooms[roomId];
        room.state = 'VOTING';
        let timeLeft = 10;
        const timer = setInterval(() => {
            timeLeft--;
            io.to(roomId).emit('timerUpdate', timeLeft);
            if (timeLeft <= 0) { clearInterval(timer); resolveVote(roomId); }
        }, 1000);
    });

    function resolveVote(roomId) {
        const room = rooms[roomId];
        // Logic โหวตออกและเช็คผลแพ้ชนะ...
        room.state = 'VOTE_RESULT';
        io.to(roomId).emit('updateRoom', room);
    }
});

server.listen(process.env.PORT || 3000);
