import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  const PORT = 3000;

  // Game state
  const players: Record<string, any> = {};

  io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Initialize player
    players[socket.id] = {
      id: socket.id,
      x: 5, // Grid coordinates
      y: 5,
      color: '#' + Math.floor(Math.random()*16777215).toString(16),
      name: `Guest_${socket.id.substring(0, 4)}`,
      message: ''
    };

    // Send current players to the new player
    socket.emit('init', players);

    // Broadcast new player to others
    socket.broadcast.emit('playerJoined', players[socket.id]);

    socket.on('move', (pos: { x: number, y: number }) => {
      if (players[socket.id]) {
        players[socket.id].x = pos.x;
        players[socket.id].y = pos.y;
        io.emit('playerMoved', { id: socket.id, x: pos.x, y: pos.y });
      }
    });

    socket.on('chat', (message: string) => {
      if (players[socket.id]) {
        players[socket.id].message = message;
        io.emit('playerChat', { id: socket.id, message });
        
        // Clear message after 5 seconds
        setTimeout(() => {
          if (players[socket.id] && players[socket.id].message === message) {
            players[socket.id].message = '';
            io.emit('playerChat', { id: socket.id, message: '' });
          }
        }, 5000);
      }
    });

    socket.on('voiceStatus', (isActive: boolean) => {
      if (players[socket.id]) {
        players[socket.id].isVoiceActive = isActive;
        io.emit('playerVoiceStatus', { id: socket.id, isActive });
      }
    });

    socket.on('disconnect', () => {
      console.log('User disconnected:', socket.id);
      delete players[socket.id];
      io.emit('playerLeft', socket.id);
    });

    // WebRTC Signaling for Voice Chat
    socket.on('callUser', (data: { userToCall: string, signalData: any, from: string }) => {
      io.to(data.userToCall).emit('incomingCall', { signal: data.signalData, from: data.from });
    });

    socket.on('answerCall', (data: { signal: any, to: string }) => {
      io.to(data.to).emit('callAccepted', data.signal);
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
