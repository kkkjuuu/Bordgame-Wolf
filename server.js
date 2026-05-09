const express = require(‘express’);
const http = require(‘http’);
const { Server } = require(‘socket.io’);
const path = require(‘path’);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname)));
app.get(’/’, (req, res) => { res.sendFile(path.join(__dirname, ‘index.html’)); });

const rooms = {};

function clearRoomTimer(roomId) {
if(rooms[roomId] && rooms[roomId].timer) {
clearInterval(rooms[roomId].timer);
rooms[roomId].timer = null;
io.to(roomId).emit(‘timerUpdate’, ‘’);
}
}

function generateDefaultName() {
const randomNum = Math.floor(Math.random() * 999) + 1;
return `wolf#${randomNum.toString().padStart(3, '0')}`;
}

function getShuffledRoles(playerCount) {
let roles = [“มนุษย์หมาป่า”, “ผู้หยั่งรู้”, “บอดี้การ์ด”];
if (playerCount >= 4) roles.push(“ชาวบ้าน”);
if (playerCount >= 5) roles.push(“ชาวบ้าน”);
if (playerCount >= 6) roles.push(“มนุษย์หมาป่า”);

```
// ✅ แก้บั๊ก: shuffle หลายรอบให้สุ่มได้แรงขึ้น
for (let round = 0; round < 3; round++) {
    for (let i = roles.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [roles[i], roles[j]] = [roles[j], roles[i]];
    }
}
return roles.slice(0, playerCount);
```

}

function broadcastRooms() {
const roomList = Object.keys(rooms).map(id => ({
id: id, currentPlayers: rooms[id].players.length, maxPlayers: rooms[id].maxPlayers,
hasPassword: rooms[id].password !== “”, state: rooms[id].state
})).filter(r => r.state === ‘LOBBY’);
io.emit(‘roomListUpdate’, roomList);
}

io.on(‘connection’, (socket) => {
broadcastRooms();

```
socket.on('createRoom', ({ roomId, playerName, maxPlayers, password, avatarUrl }) => {
    if (rooms[roomId]) return socket.emit('errorMsg', 'ชื่อห้องนี้ซ้ำ');
    let finalPlayerName = playerName && playerName.trim() !== "" ? playerName : generateDefaultName();

    socket.join(roomId);
    rooms[roomId] = {
        players: [{ id: socket.id, name: finalPlayerName, isHost: true, isAlive: true, isReady: false, wantsToPlayAgain: false, avatarUrl: avatarUrl }],
        state: 'LOBBY', maxPlayers: parseInt(maxPlayers), password: password || "",
        nightActions: { WOLF_KILL: null, GUARD_PROTECT: null }, lastGuarded: {}, votes: {}, timer: null
    };
    socket.emit('joined', { roomId, isHost: true });
    io.to(roomId).emit('updateRoom', rooms[roomId]);
    broadcastRooms();
});

socket.on('joinRoom', ({ roomId, playerName, password, avatarUrl }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit('errorMsg', 'ไม่พบห้อง');
    if (room.password !== "" && room.password !== password) return socket.emit('errorMsg', 'รหัสผ่านผิด');
    
    let finalPlayerName = playerName && playerName.trim() !== "" ? playerName : generateDefaultName();

    socket.join(roomId);
    room.players.push({ id: socket.id, name: finalPlayerName, isHost: false, isAlive: true, isReady: false, wantsToPlayAgain: false, avatarUrl: avatarUrl });
    socket.emit('joined', { roomId, isHost: false });
    io.to(roomId).emit('updateRoom', room);
    broadcastRooms();
});

socket.on('startGame', (roomId) => {
    const room = rooms[roomId];
    if (!room) return;
    
    const shuffled = getShuffledRoles(room.players.length);
    room.players.forEach((p, i) => { p.role = shuffled[i]; p.isReady = false; p.isAlive = true; p.wantsToPlayAgain = false; });
    
    room.state = 'STARTING';
    clearRoomTimer(roomId);
    io.to(roomId).emit('updateRoom', room);
    broadcastRooms();
    
    let time = 5;
    io.to(roomId).emit('timerUpdate', time);
    room.timer = setInterval(() => {
        time--;
        if (time > 0) {
            io.to(roomId).emit('timerUpdate', time);
        } else {
            clearRoomTimer(roomId);
            room.state = 'ROLE_REVEAL';
            io.to(roomId).emit('updateRoom', room);
        }
    }, 1000);
});

socket.on('playAgain', (roomId) => {
    const room = rooms[roomId];
    if (!room) return;
    const p = room.players.find(x => x.id === socket.id);
    if (p) {
        p.wantsToPlayAgain = true;
        io.to(roomId).emit('updateRoom', room);

        if (room.players.every(x => x.wantsToPlayAgain)) {
            // ✅ แก้บั๊ก: clear role ทุกคนก่อน แล้วค่อย shuffle ใหม่
            room.players.forEach(p => { p.role = null; });

            // รอ 1 tick ก่อน shuffle เพื่อให้ random seed เปลี่ยน
            setTimeout(() => {
                const shuffled = getShuffledRoles(room.players.length);
                room.players.forEach((p, i) => { 
                    p.role = shuffled[i]; p.isReady = false; p.isAlive = true; p.wantsToPlayAgain = false; 
                });
                room.state = 'STARTING';
                room.lastGuarded = {};
                room.nightActions = { WOLF_KILL: null, GUARD_PROTECT: null };
                room.shieldTarget = null;
                clearRoomTimer(roomId);
                io.to(roomId).emit('updateRoom', room);
                
                let time = 5;
                io.to(roomId).emit('timerUpdate', time);
                room.timer = setInterval(() => {
                    time--;
                    if (time > 0) {
                        io.to(roomId).emit('timerUpdate', time);
                    } else {
                        clearRoomTimer(roomId);
                        room.state = 'ROLE_REVEAL';
                        io.to(roomId).emit('updateRoom', room);
                    }
                }, 1000);
            }, 50);
        }
    }
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
            
            room.state = 'NIGHT_TRANSITION'; 
            clearRoomTimer(roomId);
            io.to(roomId).emit('updateRoom', room);
            
            let time = 3;
            io.to(roomId).emit('timerUpdate', time);
            room.timer = setInterval(() => {
                time--;
                if(time > 0) {
                    io.to(roomId).emit('timerUpdate', time);
                } else {
                    clearRoomTimer(roomId);
                    startNightPhase(roomId, 'NIGHT_WOLF');
                }
            }, 1000);
        } else {
            io.to(roomId).emit('updateRoom', room);
        }
    }
});

function startNightPhase(roomId, phase) {
    const room = rooms[roomId];
    if (!room) return;
    
    if (phase === 'NIGHT_WOLF') {
        room.nightActions = { WOLF_KILL: null, GUARD_PROTECT: null };
        room.shieldTarget = null;
    }
    room.state = phase;
    io.to(roomId).emit('updateRoom', room);

    let roleName = '';
    let nextPhase = '';
    if (phase === 'NIGHT_WOLF') { roleName = 'มนุษย์หมาป่า'; nextPhase = 'NIGHT_SEER'; }
    else if (phase === 'NIGHT_SEER') { roleName = 'ผู้หยั่งรู้'; nextPhase = 'NIGHT_BODYGUARD'; }
    else if (phase === 'NIGHT_BODYGUARD') { roleName = 'บอดี้การ์ด'; nextPhase = 'DAY_TIME'; }

    if (roleName) {
        const isAlive = room.players.some(p => p.role === roleName && p.isAlive);
        if (!isAlive) {
            setTimeout(() => {
                const currentRoom = rooms[roomId];
                if (currentRoom && currentRoom.state === phase) {
                    if (nextPhase === 'DAY_TIME') resolveNight(roomId);
                    else startNightPhase(roomId, nextPhase);
                }
            }, 3000); 
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
    room.shieldTarget = room.nightActions.GUARD_PROTECT;
    room.state = 'DAY_TIME';
    room.lastVictim = victim;
    io.to(roomId).emit('updateRoom', room);
}

socket.on('startVoting', (roomId) => {
    const room = rooms[roomId];
    if (!room || room.state === 'VOTING' || room.state === 'PRE_VOTING') return;
    
    room.state = 'PRE_VOTING'; 
    clearRoomTimer(roomId);
    io.to(roomId).emit('updateRoom', room);
    
    let time = 5;
    io.to(roomId).emit('timerUpdate', time);
    room.timer = setInterval(() => {
        time--;
        if(time > 0) {
            io.to(roomId).emit('timerUpdate', time);
        } else {
            clearRoomTimer(roomId);
            room.state = 'VOTING';
            room.votes = {};
            io.to(roomId).emit('updateRoom', room);

            let voteTime = 15;
            io.to(roomId).emit('timerUpdate', voteTime);
            room.timer = setInterval(() => {
                voteTime--;
                if (voteTime > 0) {
                    io.to(roomId).emit('timerUpdate', voteTime);
                } else {
                    clearRoomTimer(roomId);
                    resolveVote(roomId);
                }
            }, 1000);
        }
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
    if(!room) return;
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

socket.on('disconnect', () => {
    for (const roomId in rooms) {
        const room = rooms[roomId];
        const playerIndex = room.players.findIndex(p => p.id === socket.id);

        if (playerIndex !== -1) {
            const disconnectedPlayer = room.players[playerIndex];
            room.players.splice(playerIndex, 1);

            if (room.players.length === 0) {
                clearRoomTimer(roomId);
                delete rooms[roomId];
            } else {
                if (disconnectedPlayer.isHost) {
                    room.players[0].isHost = true;
                }
                if (room.state !== 'LOBBY' && room.state !== 'STARTING' && room.state !== 'ROLE_REVEAL') {
                    checkGameOver(roomId); 
                }
                if (rooms[roomId]) {
                    io.to(roomId).emit('updateRoom', room);
                }
            }
            broadcastRooms();
            break;
        }
    }
});
```

});

server.listen(process.env.PORT || 3000);