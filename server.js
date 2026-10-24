const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const rooms = {};
const lobbyTimers = {};

function leaveRoom(socket, roomId) {
    const room = rooms[roomId];
    if (!room) return;

    const playerIdx = room.players.findIndex(p => p.id === socket.id);

    if (room.gameStarted) {
        if (playerIdx !== -1) {
            room.players[playerIdx].disconnected = true;
            io.to(roomId).emit('SYNC_GAME_ACTION', { 
                actionType: 'PLAYER_KICKED', 
                payload: { playerIdx } 
            });
        }
    } else {
        room.players = room.players.filter(p => p.id !== socket.id);
    }

    socket.leave(roomId);
    socket.roomId = null;

    const activeHumanPlayers = room.players.filter(p => !p.isBot && !p.disconnected);
    if (room.players.length === 0 || (room.gameStarted && activeHumanPlayers.length === 0)) {
        if (lobbyTimers[roomId]) {
            clearInterval(lobbyTimers[roomId]);
            delete lobbyTimers[roomId];
        }
        delete rooms[roomId];
    } else {
        if (room.hostSocketId === socket.id) {
            const nextHost = room.players.find(p => !p.disconnected);
            if (nextHost) {
                room.hostSocketId = nextHost.id;
                room.host = nextHost.name;
            }
        }

        if (!room.gameStarted) {
            io.to(roomId).emit('ROOM_STATE_UPDATE', room);
        }
    }
    
    sendActiveRooms();
}

function sendActiveRooms() {
    const availableRooms = Object.values(rooms).filter(r => !r.gameStarted);
    io.emit('ROOM_LIST', availableRooms);
}

io.on('connection', (socket) => {
    console.log(`[+] Player terhubung: ${socket.id}`);

    socket.on('GET_ROOMS', () => {
        sendActiveRooms();
    });

    socket.on('CHECK_USERNAME', ({ username }) => {
        let nameUsed = false;
        for (let rId in rooms) {
            if (rooms[rId].players.some(p => p.name.toLowerCase() === username.toLowerCase())) {
                nameUsed = true;
                break;
            }
        }
        socket.emit('USERNAME_CHECK_RESULT', { available: !nameUsed });
    });

    socket.on('CREATE_ROOM', ({ roomName, username, mode }) => {
        const roomId = 'room_' + Date.now();
        rooms[roomId] = {
            id: roomId,
            name: roomName,
            mode: mode || 'klasik',
            host: username,
            hostSocketId: socket.id,
            players: [{ id: socket.id, name: username, isBot: false, ready: true }],
            gameStarted: false,
            gameState: null
        };

        socket.join(roomId);
        socket.roomId = roomId;

        socket.emit('ROOM_CREATED', rooms[roomId]);
        sendActiveRooms();

        let countdown = 10;
        if (lobbyTimers[roomId]) clearInterval(lobbyTimers[roomId]);
        lobbyTimers[roomId] = setInterval(() => {
            if (!rooms[roomId]) {
                clearInterval(lobbyTimers[roomId]);
                return;
            }
            countdown--;
            io.to(roomId).emit('LOBBY_TIMER_SYNC', { countdown });
            if (countdown <= 0) {
                clearInterval(lobbyTimers[roomId]);
                startGameInstance(roomId);
            }
        }, 1000);
    });

    socket.on('JOIN_ROOM', ({ roomId, username }) => {
        const room = rooms[roomId];
        if (!room) {
            return socket.emit('JOIN_ERROR', 'Room tidak ditemukan!');
        }
        if (room.gameStarted) {
            return socket.emit('JOIN_ERROR', 'Room sudah mulai bermain!');
        }
        if (room.players.length >= 4) {
            return socket.emit('JOIN_ERROR', 'Room sudah penuh (maks 4 player)!');
        }
        if (room.players.some(p => p.name.toLowerCase() === username.toLowerCase())) {
            return socket.emit('JOIN_ERROR', 'Username sudah digunakan di room ini!');
        }

        room.players.push({ id: socket.id, name: username, isBot: false, ready: true });
        socket.join(roomId);
        socket.roomId = roomId;

        socket.emit('ROOM_JOINED', room);
        io.to(roomId).emit('ROOM_STATE_UPDATE', room);
        sendActiveRooms();
    });

    socket.on('LEAVE_LOBBY', ({ roomId }) => {
        if (roomId) {
            leaveRoom(socket, roomId);
        }
    });

    function startGameInstance(roomId) {
        const room = rooms[roomId];
        if (!room || room.gameStarted) return;

        if (lobbyTimers[roomId]) {
            clearInterval(lobbyTimers[roomId]);
            delete lobbyTimers[roomId];
        }

        while (room.players.length < 4) {
            const botIdx = room.players.length;
            room.players.push({
                id: `bot_${botIdx}_${Date.now()}`,
                name: `BOT Cyber-${botIdx}`,
                isBot: true,
                ready: true
            });
        }

        room.gameStarted = true;
        io.to(roomId).emit('GAME_STARTED', room);
        sendActiveRooms();
    }

    socket.on('START_GAME', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        if (socket.id === room.hostSocketId) {
            startGameInstance(roomId);
        }
    });

    socket.on('GAME_ACTION', (data) => {
        const { roomId, actionType, payload } = data;
        io.to(roomId).emit('SYNC_GAME_ACTION', { actionType, payload, senderId: socket.id });
    });

    socket.on('PLAYER_TIMEOUT', ({ roomId, playerIdx }) => {
        const room = rooms[roomId];
        if (!room) return;
        io.to(roomId).emit('SYNC_GAME_ACTION', { actionType: 'PLAYER_KICKED', payload: { playerIdx } });
    });

    socket.on('disconnect', () => {
        console.log(`[-] Player terputus: ${socket.id}`);
        if (socket.roomId) {
            leaveRoom(socket, socket.roomId);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`==================================================`);
    console.log(`🚀 WALLRUSH PRO SERVER BERJALAN PADA PORT ${PORT}!`);
    console.log(`==================================================`);
});