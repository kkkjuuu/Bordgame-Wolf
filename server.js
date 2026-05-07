const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname)));

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
            lastGuarded: {},
            votes: {}
        };
        socket.emit('joined', { roomId, isHost: true });
        io.to(roomId).emit('updateRoom', rooms[roomId]);
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
        let roles = ["มนุษย์หมาป่า", "ผู้หยั่งรู้", "บอดี้การ์ด", "ชาวบ้าน"];
        if (room.players.length > 4) {
            roles = roles.concat(Array(room.players.length - 4).fill("ชาวบ้าน"));
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
        }, 3000);
    });

    socket.on('playerReady', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        const p = room.players.find(x => x.id === socket.id);
        if (p) {
            p.isReady = true;
            const alive = room.players.filter(x => x.isAlive);
            if (alive.every(x => x.isReady)) {
                room.players.forEach(x => x.isReady = false);
                room.state = 'NIGHT_WOLF';
                room.nightActions = { WOLF_KILL: null, GUARD_PROTECT: null };
                io.to(roomId).emit('updateRoom', room);
            } else {
                io.to(roomId).emit('updateRoom', room);
            }
        }
    });

    socket.on('nightAction', ({ roomId, targetId, actionType }) => {
        const room = rooms[roomId];
        if (!room) return;
        if (actionType === 'WOLF_KILL') {
            room.nightActions.WOLF_KILL = targetId;
            room.state = 'NIGHT_SEER';
        } else if (actionType === 'SEER_CHECK') {
            const target = room.players.find(x => x.id === targetId);
            socket.emit('seerResult', { name: target.name, result: target.role === 'มนุษย์หมาป่า' ? 'คนร้าย' : 'คนดี' });
            room.state = 'NIGHT_BODYGUARD';
        } else if (actionType === 'GUARD_PROTECT') {
            room.nightActions.GUARD_PROTECT = targetId;
            room.lastGuarded[socket.id] = targetId;
            resolveNight(roomId);
        }
        io.to(roomId).emit('updateRoom', room);
    });

    function resolveNight(roomId) {
        const room = rooms[roomId];
        let victim = null;
        if (room.nightActions.WOLF_KILL !== room.nightActions.GUARD_PROTECT) {
            const p = room.players.find(x => x.id === room.nightActions.WOLF_KILL);
            if (p) { p.isAlive = false; victim = p.name; }
        }
        room.state = 'DAY_TIME';
        room.lastVictim = victim;
        io.to(roomId).emit('updateRoom', room);
    }

    // --- ระบบโหวต ---
    socket.on('startVoting', (roomId) => {
        const room = rooms[roomId];
        if (!room || room.state === 'VOTING') return;
        room.state = 'VOTING';
        room.votes = {};
        io.to(roomId).emit('updateRoom', room);

        let time = 15; // จับเวลาโหวต 15 วินาที
        const timer = setInterval(() => {
            time--;
            io.to(roomId).emit('timerUpdate', time);
            if (time <= 0) {
                clearInterval(timer);
                resolveVote(roomId);
            }
        }, 1000);
    });

    socket.on('castVote', ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (room && room.state === 'VOTING') {
            room.votes[socket.id] = targetId;
            // ส่งจำนวนคนที่โหวตแล้วกลับไป
            io.to(roomId).emit('voteCountUpdate', Object.keys(room.votes).length);
        }
    });

    function resolveVote(roomId) {
        const room = rooms[roomId];
        if (!room) return;
        
        const counts = {};
        Object.values(room.votes).forEach(id => counts[id] = (counts[id] || 0) + 1);

        let eliminatedId = null;
        let maxVotes = 0;
        // หาคนที่ได้คะแนนสูงสุด
        for (let [id, count] of Object.entries(counts)) {
            if (count > maxVotes && id !== 'SKIP') {
                maxVotes = count;
                eliminatedId = id;
            } else if (count === maxVotes) {
                eliminatedId = null; // ถ้าคะแนนเท่ากัน = ไม่มีใครออก
            }
        }

        let victim = null;
        if (eliminatedId) {
            const p = room.players.find(x => x.id === eliminatedId);
            if (p) { p.isAlive = false; victim = p.name; }
        }

        room.state = 'DAY_RESULT';
        room.lastEliminated = victim;
        io.to(roomId).emit('updateRoom', room);

        setTimeout(() => { checkGameOver(roomId); }, 4000);
    }

    function checkGameOver(roomId) {
        const room = rooms[roomId];
        const wolves = room.players.filter(p => p.role === 'มนุษย์หมาป่า' && p.isAlive);
        const villagers = room.players.filter(p => p.role !== 'มนุษย์หมาป่า' && p.isAlive);

        if (wolves.length === 0) {
            room.state = 'GAME_OVER'; room.winner = 'ฝ่ายชาวบ้าน ชนะ!';
        } else if (wolves.length >= villagers.length) {
            room.state = 'GAME_OVER'; room.winner = 'ฝ่ายหมาป่า ชนะ!';
        } else {
            room.state = 'ROLE_REVEAL'; // วนกลับไปกดพร้อมใหม่
            room.players.forEach(p => p.isReady = false);
        }
        io.to(roomId).emit('updateRoom', room);
    }
});

server.listen(process.env.PORT || 3000);
