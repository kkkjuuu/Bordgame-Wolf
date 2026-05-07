const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

const rooms = {};

function broadcastRooms() {
    const roomList = Object.keys(rooms).map(id => ({
        id: id, currentPlayers: rooms[id].players.length, maxPlayers: rooms[id].maxPlayers,
        hasPassword: rooms[id].password !== "", state: rooms[id].state
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
            state: 'LOBBY', maxPlayers: parseInt(maxPlayers), password: password || "",
            nightActions: { WOLF_KILL: null, GUARD_PROTECT: null }, lastGuarded: {}, votes: {}
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
        room.players.forEach((p, i) => { p.role = shuffled[i]; p.isReady = false; p.isAlive = true; });
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
                startNightPhase(roomId, 'NIGHT_WOLF');
            } else {
                io.to(roomId).emit('updateRoom', room);
            }
        }
    });

    // ----------------------------------------------------
    // ฟังก์ชันจัดการกลางคืน (พร้อมระบบข้ามอัตโนมัติถ้าบทนั้นตาย)
    // ----------------------------------------------------
    function startNightPhase(roomId, phase) {
        const room = rooms[roomId];
        if (!room) return;
        
        // รีเซ็ตค่าถ้าเป็นการเริ่มคืนใหม่
        if (phase === 'NIGHT_WOLF') {
            room.nightActions = { WOLF_KILL: null, GUARD_PROTECT: null };
        }

        room.state = phase;
        io.to(roomId).emit('updateRoom', room);

        let roleName = '';
        let nextPhase = '';
        if (phase === 'NIGHT_WOLF') { roleName = 'มนุษย์หมาป่า'; nextPhase = 'NIGHT_SEER'; }
        else if (phase === 'NIGHT_SEER') { roleName = 'ผู้หยั่งรู้'; nextPhase = 'NIGHT_BODYGUARD'; }
        else if (phase === 'NIGHT_BODYGUARD') { roleName = 'บอดี้การ์ด'; nextPhase = 'DAY_TIME'; }

        if (roleName) {
            // เช็คว่าบทบาทนั้นยังมีชีวิตอยู่ไหม
            const isAlive = room.players.some(p => p.role === roleName && p.isAlive);
            
            if (!isAlive) {
                // ถ้าตายแล้ว ให้รอ 4 วินาที (เพื่อให้เสียงพากย์ทำงานจบ) แล้วข้ามไปบทถัดไปอัตโนมัติ
                setTimeout(() => {
                    const currentRoom = rooms[roomId];
                    if (currentRoom && currentRoom.state === phase) {
                        if (nextPhase === 'DAY_TIME') {
                            resolveNight(roomId);
                        } else {
                            startNightPhase(roomId, nextPhase);
                        }
                    }
                }, 4000); 
            }
        }
    }

    socket.on('nightAction', ({ roomId, targetId, actionType }) => {
        const room = rooms[roomId];
        if (!room) return;
        if (actionType === 'WOLF_KILL') {
            room.nightActions.WOLF_KILL = targetId;
            startNightPhase(roomId, 'NIGHT_SEER');
        } else if (actionType === 'SEER_CHECK') {
            const target = room.players.find(x => x.id === targetId);
            socket.emit('seerResult', { name: target.name, result: target.role === 'มนุษย์หมาป่า' ? 'คนร้าย' : 'คนดี' });
            startNightPhase(roomId, 'NIGHT_BODYGUARD');
        } else if (actionType === 'GUARD_PROTECT') {
            room.nightActions.GUARD_PROTECT = targetId;
            room.lastGuarded[socket.id] = targetId;
            resolveNight(roomId);
        }
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

    socket.on('startVoting', (roomId) => {
        const room = rooms[roomId];
        if (!room || room.state === 'VOTING') return;
        room.state = 'VOTING';
        room.votes = {};
        io.to(roomId).emit('updateRoom', room);

        let time = 15;
        const timer = setInterval(() => {
            time--;
            io.to(roomId).emit('timerUpdate', time);
            if (time <= 0) { clearInterval(timer); resolveVote(roomId); }
        }, 1000);
    });

    socket.on('castVote', ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (room && room.state === 'VOTING') {
            room.votes[socket.id] = targetId;
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
        for (let [id, count] of Object.entries(counts)) {
            if (count > maxVotes && id !== 'SKIP') { maxVotes = count; eliminatedId = id; } 
            else if (count === maxVotes) { eliminatedId = null; }
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
            room.state = 'ROLE_REVEAL'; 
            room.players.forEach(p => p.isReady = false);
        }
        io.to(roomId).emit('updateRoom', room);
    }
});

server.listen(process.env.PORT || 3000);
