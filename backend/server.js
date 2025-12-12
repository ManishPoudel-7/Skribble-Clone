const express = require('express');
const http = require('http');
const path = require('path');
const {Server} = require('socket.io');

const port = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);

// Socket.IO with CORS and production config
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000
});

//Socket IO
const roomPlayers = {};
let roomTurns = {};
const roomHosts = {};
const gameStarted = {};
const messages = {};
const roomScores = {}; // Track scores per room
const roomSettings = {}; // Store room settings like total rounds

const TOTAL_ROUNDS = 3; // Total rounds per game
const POINTS = [100, 80, 60, 40, 20]; // Points for 1st, 2nd, 3rd, 4th, 5th guesser
const DRAWER_POINTS = 10; // Points drawer gets per correct guess

io.on('connection', (socket) => {
    console.log(`A new user has been connected. ID: ${socket.id}`);

    // ---------------- CREATE ROOM ----------------
    socket.on("createRoom", (roomId) => {
        socket.join(roomId);
        socket.emit("roomCreated", {roomId});
        console.log(`User ${socket.id} created and joined room ${roomId}`);

        if (!roomPlayers[roomId]) {
            roomPlayers[roomId] = [];
            roomHosts[roomId] = socket.id;
            gameStarted[roomId] = false;
            messages[roomId] = [];
            roomScores[roomId] = {};
            roomSettings[roomId] = {
                currentRound: 0,
                totalRounds: TOTAL_ROUNDS
            };
        }

        socket.emit("youAreHost", true);
    });

    // ---------------- JOIN ROOM ----------------
    socket.on("joinRoom", ({ roomId, name, mascot }) => {
    socket.join(roomId);
    console.log(`User ${socket.id} joined room ${roomId} as ${mascot} ${name}`);

    if (!roomPlayers[roomId]) {
        roomPlayers[roomId] = [];
        roomHosts[roomId] = socket.id;
        gameStarted[roomId] = false;
        messages[roomId] = [];
        roomScores[roomId] = {};
        roomSettings[roomId] = {
            currentRound: 0,
            totalRounds: TOTAL_ROUNDS
        };
        socket.emit("youAreHost", true);
    }

    const alreadyExists = roomPlayers[roomId].some(p => p.id === socket.id);

    if (!alreadyExists) {
        roomPlayers[roomId].push({ id: socket.id, name, mascot });
        
        // Initialize score for new player
        if(!roomScores[roomId][socket.id]) {
            roomScores[roomId][socket.id] = {
                name: name,
                score: 0
            };
        }
    }

    // IMPORTANT: Check if this user is the host
    if(roomHosts[roomId] === socket.id) {
        socket.emit("youAreHost", true);
    } else {
        socket.emit("youAreHost", false);
    }

    // Send game state to the joining player
    if(gameStarted[roomId] && roomTurns[roomId]) {
        let currentDrawer = roomPlayers[roomId][roomTurns[roomId].turnIndex];
        socket.emit("currentDrawer", currentDrawer.id);
        
        if(roomTurns[roomId].chosenWord){
            socket.emit("maskedWord", "_ ".repeat(roomTurns[roomId].chosenWord.length));
            if(roomTimers[roomId] && roomTimers[roomId].timeRemaining !== undefined) {
                socket.emit("timerUpdate", roomTimers[roomId].timeRemaining);
            }
        } else {
            socket.emit("waitingForWord", {
                drawerName: currentDrawer.name
            });
        }
    } else {
        socket.emit("waitingToStart");
    }

    // Update all players in the room (including the one who just joined)
    io.to(roomId).emit("updatePlayers", roomPlayers[roomId]);
    io.to(roomId).emit("updateScores", roomScores[roomId]);
    
    if(messages[roomId]) {
        socket.emit('updatedMessages', messages[roomId]);
    }
});

    // ---------------- START GAME ----------------
    socket.on("startGame", (roomId) => {
        if(roomHosts[roomId] !== socket.id) {
            socket.emit("error", "Only the host can start the game");
            return;
        }

        if(roomPlayers[roomId].length < 2) {
            socket.emit("error", "Need at least 2 players to start");
            return;
        }

        if(gameStarted[roomId]) {
            socket.emit("error", "Game already started");
            return;
        }

        gameStarted[roomId] = true;
        roomTurns[roomId] = {
            turnIndex: 0, 
            chosenWord: null,
            guessedPlayers: [],
            drawerId: null
        };
        roomSettings[roomId].currentRound = 1;
        
        io.to(roomId).emit("gameStarted");
        io.to(roomId).emit("roundUpdate", {
            current: roomSettings[roomId].currentRound,
            total: roomSettings[roomId].totalRounds
        });
        startTurn(roomId);
    });

    // ---------------- CHAT ----------------
    socket.on('updatedMessages', (msgObj) => {
        const roomId = [...socket.rooms][1];
        if(!messages[roomId]) messages[roomId] = [];
        
        messages[roomId].push(msgObj);
        io.to(roomId).emit('updatedMessages', messages[roomId]);
    });

    // Message Guessing with Scoring
    socket.on('newMessages', (msgObj) => {
        const roomId = [...socket.rooms][1];
        const chosenWord = roomTurns[roomId]?.chosenWord;
        const currentDrawer = roomPlayers[roomId][roomTurns[roomId].turnIndex];

        // Don't let drawer guess their own word
        if(socket.id === currentDrawer.id) {
            return;
        }

        // Check if player already guessed
        if(roomTurns[roomId].guessedPlayers.includes(socket.id)) {
            if(!messages[roomId]) messages[roomId] = [];
            messages[roomId].push(msgObj);
            io.to(roomId).emit('updatedMessages', messages[roomId]);
            return;
        }

        if(chosenWord && msgObj.text.toLowerCase().trim() === chosenWord.toLowerCase().trim()){
            // Player guessed correctly!
            const guessPosition = roomTurns[roomId].guessedPlayers.length;
            roomTurns[roomId].guessedPlayers.push(socket.id);
            
            // Award points
            const pointsAwarded = POINTS[guessPosition] || 10; // Default 10 if beyond 5th
            roomScores[roomId][socket.id].score += pointsAwarded;
            
            // Award points to drawer
            roomScores[roomId][currentDrawer.id].score += DRAWER_POINTS;
            
            io.to(roomId).emit("playerGuessed", {
                name: msgObj.name,
                points: pointsAwarded,
                position: guessPosition + 1
            });

            // Update scores
            io.to(roomId).emit("updateScores", roomScores[roomId]);

            // Check if all players (except drawer) have guessed
            const totalGuessers = roomPlayers[roomId].length - 1;
            if(roomTurns[roomId].guessedPlayers.length >= totalGuessers) {
                // Everyone guessed! Move to next turn
                if(roomTimers[roomId]) {
                    clearInterval(roomTimers[roomId].interval);
                    delete roomTimers[roomId];
                }
                
                io.to(roomId).emit("allGuessed", {
                    word: chosenWord
                });
                
                setTimeout(() => {
                    nextTurn(roomId);
                }, 3000); // 3 second delay before next turn
            }
        } else {
            // Wrong guess, just add to chat
            if(!messages[roomId]) messages[roomId] = [];
            messages[roomId].push(msgObj);
            io.to(roomId).emit('updatedMessages', messages[roomId]);
        }
    });

    // ---------------- WORD CHOSEN ----------------
    socket.on("wordChosen", (word) => {
        const roomId = [...socket.rooms][1];
        
        if(!gameStarted[roomId] || !roomTurns[roomId]) return;
        
        let currentDrawer = roomPlayers[roomId][roomTurns[roomId].turnIndex];
        if(currentDrawer.id !== socket.id) {
            console.log("Non-drawer tried to choose word");
            return;
        }
        
        if(roomTimers[roomId]) {
            clearInterval(roomTimers[roomId].interval);
        }
        
        roomTurns[roomId].chosenWord = word;
        roomTurns[roomId].guessedPlayers = []; // Reset guessed players

        io.to(roomId).emit("roundStarted");

        socket.broadcast.to(roomId).emit("maskedWord", "_ ".repeat(word.length));
        socket.emit("drawerWord", word);
        
        startRoundTimer(roomId);
    });

    // ---------------- DRAWING EVENTS ----------------
    socket.on("drawing", (data) => {
        const roomId = [...socket.rooms][1];
        socket.broadcast.to(roomId).emit("drawing", data);
    });

    socket.on("clearCanvas", () => {
        const roomId = [...socket.rooms][1];
        socket.broadcast.to(roomId).emit("clearCanvas");
    });

    // ---------------- DISCONNECT ----------------
    socket.on("disconnect", () => {
        for (const roomId in roomPlayers) {
            roomPlayers[roomId] = roomPlayers[roomId].filter(p => p.id !== socket.id);
            io.to(roomId).emit("updatePlayers", roomPlayers[roomId]);
            
            if(roomHosts[roomId] === socket.id && roomPlayers[roomId].length > 0) {
                roomHosts[roomId] = roomPlayers[roomId][0].id;
                io.to(roomHosts[roomId]).emit("youAreHost", true);
            }
            
            if(roomPlayers[roomId].length === 0) {
                if(roomTimers[roomId]) {
                    clearInterval(roomTimers[roomId].interval);
                    delete roomTimers[roomId];
                }
                delete roomPlayers[roomId];
                delete roomTurns[roomId];
                delete roomHosts[roomId];
                delete gameStarted[roomId];
                delete messages[roomId];
                delete roomScores[roomId];
                delete roomSettings[roomId];
            }
        }
    });
});

// Server Side Timer
const roomTimers = {};
function startRoundTimer(roomId){
    let timeRemaining = 80;

    io.to(roomId).emit("timerUpdate", timeRemaining);

    const interval = setInterval(() => {
        timeRemaining--;
        io.to(roomId).emit("timerUpdate", timeRemaining);

        if(timeRemaining < 0){
            clearInterval(interval);
            delete roomTimers[roomId];
            io.to(roomId).emit("timeUp");
            
            // Reveal the word
            const word = roomTurns[roomId]?.chosenWord;
            if(word) {
                io.to(roomId).emit("revealWord", word);
            }
            
            setTimeout(() => {
                nextTurn(roomId);
            }, 3000);
        }
    }, 1000);

    roomTimers[roomId] = { interval, timeRemaining };
}

// Drawing Turn Code
function startTurn(roomId){
    let players = roomPlayers[roomId];
    
    if(!roomTurns[roomId]) return;
    let turnIndex = roomTurns[roomId].turnIndex;

    if(!players || players.length === 0) return;
    
    // Check if round is complete (everyone has drawn once)
    if(turnIndex >= players.length){
        turnIndex = 0;
        roomTurns[roomId].turnIndex = 0;
        roomSettings[roomId].currentRound++;
        
        // Check if game is over
        if(roomSettings[roomId].currentRound > roomSettings[roomId].totalRounds) {
            endGame(roomId);
            return;
        }
        
        io.to(roomId).emit("roundUpdate", {
            current: roomSettings[roomId].currentRound,
            total: roomSettings[roomId].totalRounds
        });
    }

    let currentPlayer = players[turnIndex];

    roomTurns[roomId].chosenWord = null;
    roomTurns[roomId].guessedPlayers = [];
    roomTurns[roomId].drawerId = currentPlayer.id;

    io.to(roomId).emit("clearCanvas");
    io.to(roomId).emit("currentDrawer", currentPlayer.id);

    io.to(roomId).emit("turnStarted", {
        drawerId: currentPlayer.id,
        drawerName: currentPlayer.name
    });

    io.to(roomId).emit("waitingForWord", {
        drawerName: currentPlayer.name
    });

    let options = getRandomWords();
    io.to(currentPlayer.id).emit("wordOptions", options);
}

// Next Turn Function
function nextTurn(roomId){
    if(!roomTurns[roomId]) return;
    roomTurns[roomId].turnIndex++;
    startTurn(roomId);
}

// End Game Function
function endGame(roomId) {
    // Calculate rankings
    const scores = roomScores[roomId];
    const rankings = Object.keys(scores)
        .map(playerId => ({
            id: playerId,
            name: scores[playerId].name,
            score: scores[playerId].score
        }))
        .sort((a, b) => b.score - a.score);

    io.to(roomId).emit("gameOver", {
        rankings: rankings
    });

    // Reset game state
    gameStarted[roomId] = false;
    roomTurns[roomId] = null;
    roomSettings[roomId].currentRound = 0;
    
    // Reset scores
    for(let playerId in roomScores[roomId]) {
        roomScores[roomId][playerId].score = 0;
    }
}

// Word Selection
const words = [
    "apple", "banana", "car", "dog", "elephant", "fish", "guitar", "house",
    "ice cream", "jacket", "kite", "lion", "mountain", "notebook", "ocean",
    "pizza", "queen", "rainbow", "sun", "tree", "umbrella", "violin",
    "whale", "xylophone", "yacht", "zebra", "airplane", "butterfly", "castle",
    "dragon", "football", "hamburger", "island", "jellyfish", "kangaroo"
];

function getRandomWords(){
    let selected = [];
    while(selected.length < 3){
        let randomIndex = Math.floor(Math.random() * words.length);
        let word = words[randomIndex];

        if(!selected.includes(word)){
            selected.push(word);
        }
    }
    return selected;
}

app.use(express.static(path.join(__dirname, "../frontend"), {
    index: false
}));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/firstPage.html'));
});

server.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);  
});