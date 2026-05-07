const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- แก้ไขตรงนี้: ดึงไฟล์ index.html จากหน้าแรกโดยตรง ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
// --------------------------------------------------

const rooms = {};

// ฟังก์ชันจัดบทบาทให้สมดุล
function getBalancedRoles(count) {
    let roles = [];
    if (count == 4) roles = ["หมาป่า (Werewolf)", "นายอำเภอ (Sheriff)", "ชาวบ้าน", "ชาวบ้าน"];
    else if (count == 5) roles = ["หมาป่า (Werewolf)", "นายอำเภอ (Sheriff)", "ชาวบ้าน", "ชาวบ้าน", "ชาวบ้าน"];
    else if (count == 6) roles = ["หมาป่า (Werewolf)", "หมาป่า (Werewolf)", "นายอำเภอ (Sheriff)", "ชาวบ้าน", "ชาวบ้าน", "ชาวบ้าน"];
    else if (count >= 8) {
        roles = ["หมาป่า (Werewolf)", "หมาป่า (Werewolf)", "นายอำเภอ (Sheriff)", "ผู้หยั่งรู้ (Seer)"];
        while (roles.length < count) roles.push("ชาวบ้าน");
    }
    // สับการ์ด
    return roles.sort(() => Math.random() - 0.5);
}

io.on('connection', (socket) => {
    
    socket.on('joinRoom', ({ roomId, playerName, maxPlayers }) => {
        socket.join(roomId);
        
        if (!rooms[roomId]) {
            rooms[roomId] = { 
                players: [], state: 'LOBBY', 
                maxPlayers: parseInt(maxPlayers) || 4,
                readyCount: 0, nightActions: { wolf: null, sheriff: null },
                votes: {}, aliveCount: 0
            };
        }
        
        let room = rooms[roomId];
        
        if (room.players.length >= room.maxPlayers) {
            socket.emit('errorMsg', 'ห้องเต็มแล้ว!');
            return;
        }

        room.players.push({
            id: socket.id,
            name: playerName,
            role: null,
            isAlive: true,
            isReady: false
        });

        io.to(roomId).emit('updateRoom', room);

        if (room.players.length === room.maxPlayers) {
            startGame(roomId);
        }
    });

    function startGame(roomId) {
        let room = rooms[roomId];
        let roles = getBalancedRoles(room.maxPlayers);
        
        room.players.forEach((p, index) => {
            p.role = roles[index];
            p.isAlive = true;
            p.isReady = false;
        });
        
        room.state = 'ROLE_REVEAL';
        room.aliveCount = room.maxPlayers;
        io.to(roomId).emit('updateRoom', room);
    }

    socket.on('playerReady', (roomId) => {
        let room = rooms[roomId];
        if(!room) return;
        
        let player = room.players.find(p => p.id === socket.id);
        if(player && !player.isReady) {
            player.isReady = true;
            room.readyCount++;
            io.to(roomId).emit('updateRoom', room);

            if (room.readyCount === room.aliveCount) {
                room.readyCount = 0;
                room.players.forEach(p => p.isReady = false);
                startNight(roomId);
            }
        }
    });

    function startNight(roomId) {
        let room = rooms[roomId];
        room.state = 'NIGHT_WOLF';
        room.nightActions = { wolf: null, sheriff: null };
        io.to(roomId).emit('updateRoom', room);
        io.to(roomId).emit('systemVoice', 'เข้าสู่ช่วงกลางคืน หมาป่าลืมตา โปรดเลือกผู้เล่นที่จะฆ่า');
    }

    socket.on('nightAction', ({ roomId, targetId, actionType }) => {
        let room = rooms[roomId];
        if(!room) return;

        if (actionType === 'WOLF_KILL') {
            room.nightActions.wolf = targetId;
            room.state = 'NIGHT_SHERIFF';
            io.to(roomId).emit('updateRoom', room);
            io.to(roomId).emit('systemVoice', 'หมาป่าหลับตา นายอำเภอลืมตา โปรดเลือกผู้เล่นที่จะปกป้อง');
        } 
        else if (actionType === 'SHERIFF_PROTECT' || actionType === 'SKIP') {
            room.nightActions.sheriff = targetId === 'SKIP' ? null : targetId;
            resolveNight(roomId);
        }
    });

    function resolveNight(roomId) {
        let room = rooms[roomId];
        let deadPlayer = null;

        if (room.nightActions.wolf && room.nightActions.wolf !== room.nightActions.sheriff) {
            let victim = room.players.find(p => p.id === room.nightActions.wolf);
            if(victim) {
                victim.isAlive = false;
                deadPlayer = victim.name;
                room.aliveCount--;
            }
        }

        room.state = 'DAY_DISCUSSION';
        io.to(roomId).emit('updateRoom', room);
        
        let announcement = 'ทุกคนลืมตา สู่เช้าวันใหม่ ';
        announcement += deadPlayer ? `เมื่อคืนนี้ ${deadPlayer} ถูกฆ่าตาย` : 'เมื่อคืนนี้ ไม่มีใครตาย';
        io.to(roomId).emit('systemVoice', announcement);
        
        checkWinCondition(roomId);
    }

    socket.on('startVote', (roomId) => {
        let room = rooms[roomId];
        if(room) {
            room.state = 'VOTING';
            room.votes = {};
            io.to(roomId).emit('updateRoom', room);
            io.to(roomId).emit('systemVoice', 'เข้าสู่ช่วงโหวต โปรดเลือกผู้เล่นที่คุณสงสัย');
        }
    });

    socket.on('votePlayer', ({ roomId, targetId }) => {
        let room = rooms[roomId];
        if(!room) return;

        room.votes[socket.id] = targetId;
        
        if (Object.keys(room.votes).length === room.aliveCount) {
            resolveVote(roomId);
        }
    });

    function resolveVote(roomId) {
        let room = rooms[roomId];
        let voteCounts = {};
        
        Object.values(room.votes).forEach(targetId => {
            voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
        });

        let maxVotes = 0;
        let eliminatedId = null;
        for (let [id, count] of Object.entries(voteCounts)) {
            if (count > maxVotes) {
                maxVotes = count;
                eliminatedId = id;
            }
        }

        let eliminatedPlayer = room.players.find(p => p.id === eliminatedId);
        if (eliminatedPlayer) {
            eliminatedPlayer.isAlive = false;
            room.aliveCount--;
            io.to(roomId).emit('systemVoice', `มติเอกฉันท์ ${eliminatedPlayer.name} ถูกโหวตออกจากหมู่บ้าน`);
        }

        room.state = 'ROLE_REVEAL'; 
        io.to(roomId).emit('updateRoom', room);
        checkWinCondition(roomId);
    }

    function checkWinCondition(roomId) {
        let room = rooms[roomId];
        let wolves = room.players.filter(p => p.role.includes('หมาป่า') && p.isAlive);
        let villagers = room.players.filter(p => !p.role.includes('หมาป่า') && p.isAlive);

        if (wolves.length === 0) {
            room.state = 'GAME_OVER';
            io.to(roomId).emit('updateRoom', room);
            io.to(roomId).emit('systemVoice', 'หมาป่าตายหมดแล้ว ฝ่ายชาวบ้านเป็นผู้ชนะ');
        } else if (wolves.length >= villagers.length) {
            room.state = 'GAME_OVER';
            io.to(roomId).emit('updateRoom', room);
            io.to(roomId).emit('systemVoice', 'หมาป่ามีจำนวนเท่ากับชาวบ้าน ฝ่ายหมาป่าเป็นผู้ชนะ');
        }
    }

    socket.on('disconnect', () => {
        // สามารถเพิ่มระบบจัดการผู้เล่นหลุดได้ในอนาคต
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
