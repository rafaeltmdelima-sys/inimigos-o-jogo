import React, { useEffect, useState, useRef } from 'react';
import * as Phaser from 'phaser';
import { rtdb, auth, loginWithGoogle, loginAnonymously } from './lib/firebase';
import { onAuthStateChanged, User as FirebaseUser } from 'firebase/auth';
import { 
  ref, 
  set, 
  onValue, 
  update, 
  push, 
  onDisconnect,
  serverTimestamp
} from 'firebase/database';
import { io, Socket } from 'socket.io-client';
import { Send, User, MessageSquare, Mic, MicOff, LogIn } from 'lucide-react';
import Peer from 'simple-peer';
import { Buffer } from 'buffer';

// Polyfills for simple-peer
if (typeof window !== 'undefined') {
  if (!(window as any).global) (window as any).global = window;
  if (!(window as any).Buffer) (window as any).Buffer = Buffer;
}

// Isometric constants
const TILE_WIDTH = 64;
const TILE_HEIGHT = 32;
const GRID_SIZE = 12;

const cartesianToIso = (x: number, y: number) => ({
  x: (x - y) * (TILE_WIDTH / 2),
  y: (x + y) * (TILE_HEIGHT / 2)
});

interface PlayerData {
  id: string;
  x: number;
  y: number;
  color: number;
  name: string;
  message: string;
  isVoiceActive?: boolean;
}

export default function App() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [players, setPlayers] = useState<Record<string, PlayerData>>({});
  const [chatInput, setChatInput] = useState('');
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);

  const gameRef = useRef<Phaser.Game | null>(null);
  const playersSprites = useRef<Record<string, Phaser.GameObjects.Container>>({});
  const peersRef = useRef<Record<string, Peer.Instance>>({});
  const playersRef = useRef<Record<string, PlayerData>>({});

  // Sync players state to ref for Phaser access
  useEffect(() => {
    playersRef.current = players;
  }, [players]);

  // Firebase Auth & RTDB Initialization
  useEffect(() => {
    console.log("Initializing Auth Listener...");
    const unsubscribe = onAuthStateChanged(auth, async (u) => {
      console.log("Auth State Changed:", u ? `User logged in: ${u.uid}` : "No user logged in");
      if (!u) {
        try {
          console.log("Attempting anonymous login...");
          await loginAnonymously();
          console.log("Anonymous login successful");
        } catch (err) {
          console.error("Anonymous login failed:", err);
          setIsAuthLoading(false); // Stop loading even if it fails so we can see the error in console
        }
      } else {
        setUser(u);
        setIsAuthLoading(false);
        
        try {
          const playerRef = ref(rtdb, `jogadores/${u.uid}`);
          console.log(`Setting initial player data for ${u.uid}...`);
          
          // Initial player data
          const initialData = {
            id: u.uid,
            name: u.displayName || `Anon_${u.uid.substring(0, 4)}`,
            x: 5,
            y: 5,
            color: Math.floor(Math.random() * 16777215),
            message: '',
            lastActive: serverTimestamp()
          };

          await set(playerRef, initialData);
          console.log("Initial player data set successfully");
          
          // Remove player on disconnect
          onDisconnect(playerRef).remove().then(() => {
            console.log("OnDisconnect hook set");
          }).catch(err => console.error("Error setting onDisconnect:", err));
          
        } catch (err) {
          console.error("Error during RTDB initialization:", err);
        }
      }
    });
    return () => unsubscribe();
  }, []);

  // Realtime Database Listener
  useEffect(() => {
    if (!user) return;
    
    // Monitor connection status
    const connectedRef = ref(rtdb, ".info/connected");
    onValue(connectedRef, (snap) => {
      if (snap.val() === true) {
        console.log("RTDB Connected successfully");
      } else {
        console.warn("RTDB Disconnected. Checking databaseURL and rules...");
      }
    });

    console.log("Starting RTDB onValue listener for 'jogadores'...");
    const playersRef = ref(rtdb, 'jogadores');
    const unsubscribe = onValue(playersRef, (snapshot) => {
      const data = snapshot.val() || {};
      console.log("RTDB Data Received:", Object.keys(data).length, "players found");
      setPlayers(data);
    }, (error) => {
      console.error("RTDB onValue Error:", error);
    });
    return () => unsubscribe();
  }, [user]);

  // WebRTC Signaling (Signaling only)
  useEffect(() => {
    const newSocket = io();
    setSocket(newSocket);
    newSocket.on("incomingCall", (data: { signal: any, from: string }) => {
      if (isVoiceActive && stream) {
        const peer = new Peer({ initiator: false, trickle: false, stream });
        peer.on("signal", signal => newSocket.emit("answerCall", { signal, to: data.from }));
        peer.on("stream", s => {
          const audio = new Audio();
          audio.srcObject = s;
          const playPromise = audio.play();
          if (playPromise !== undefined) {
            playPromise.catch(error => {
              console.warn("Audio play blocked by browser. User interaction may be required.", error);
            });
          }
        });
        peer.signal(data.signal);
        peersRef.current[data.from] = peer;
      }
    });
    newSocket.on("callAccepted", (signal: any) => {
      Object.values(peersRef.current).forEach(p => p.signal(signal));
    });
    return () => { newSocket.close(); };
  }, [isVoiceActive, stream]);

  // Phaser Game
  useEffect(() => {
    if (!user || gameRef.current) return;

    const config: Phaser.Types.Core.GameConfig = {
      type: Phaser.CANVAS,
      parent: 'phaser-game',
      width: window.innerWidth,
      height: window.innerHeight,
      scale: {
        mode: Phaser.Scale.RESIZE,
        autoCenter: Phaser.Scale.CENTER_BOTH
      },
      backgroundColor: '#0f0f1a',
      pixelArt: true, // PIXEL ART STYLE
      audio: {
        noAudio: true
      },
      scene: {
        create: function(this: Phaser.Scene) {
          console.log("Phaser Scene Create started");
          
          // Draw Ground
          const ground = this.add.graphics();
          ground.fillStyle(0x161625, 1);
          ground.fillRect(-2000, -2000, 4000, 4000);
          ground.setDepth(-200);

          // Draw Isometric Grid
          for (let i = 0; i < GRID_SIZE; i++) {
            for (let j = 0; j < GRID_SIZE; j++) {
              const { x, y } = cartesianToIso(i, j);
              const points = [0, -16, 32, 0, 0, 16, -32, 0];
              
              // Draw tile background
              const poly = this.add.polygon(x, y, points, 0x242435);
              poly.setStrokeStyle(1, 0x1a1a2e, 0.5);
              poly.setInteractive(new Phaser.Geom.Polygon(points), Phaser.Geom.Polygon.Contains);
              
              poly.on('pointerdown', () => enviarMovimento(i, j));
              poly.on('pointerover', () => poly.setFillStyle(0x32324a));
              poly.on('pointerout', () => poly.setFillStyle(0x242435));
              poly.setDepth(-100);
            }
          }
          
          // Draw Room Border
          const border = this.add.graphics();
          border.lineStyle(2, 0x4f46e5, 0.3);
          const p1 = cartesianToIso(-0.5, -0.5);
          const p2 = cartesianToIso(GRID_SIZE - 0.5, -0.5);
          const p3 = cartesianToIso(GRID_SIZE - 0.5, GRID_SIZE - 0.5);
          const p4 = cartesianToIso(-0.5, GRID_SIZE - 0.5);
          border.strokePoints([p1, p2, p3, p4, p1], true);
          border.setDepth(-99);

          // Set Camera Bounds
          const totalWidth = GRID_SIZE * TILE_WIDTH * 2;
          const totalHeight = GRID_SIZE * TILE_HEIGHT * 2;
          this.cameras.main.setBounds(-totalWidth/2, -totalHeight/4, totalWidth, totalHeight);
          this.cameras.main.centerOn(0, GRID_SIZE * TILE_HEIGHT / 2);
          
          // Responsive zoom
          const zoom = window.innerWidth < 640 ? 1.0 : 1.5;
          this.cameras.main.setZoom(zoom);
          
          console.log("Phaser Scene Create finished");
        },
        update: function(this: Phaser.Scene) {
          const currentPlayers = playersRef.current;
          
          // Debug log every 100 frames
          if (this.game.loop.frame % 100 === 0) {
            console.log("Phaser Update Loop: Syncing", Object.keys(currentPlayers).length, "players");
          }

          // Sync Sprites
          Object.keys(currentPlayers).forEach(id => {
            const p = currentPlayers[id];
            const { x, y } = cartesianToIso(p.x, p.y);
            
            if (!playersSprites.current[id]) {
              const container = this.add.container(x, y);
              const body = this.add.rectangle(0, -10, 20, 40, p.color).setStrokeStyle(2, 0xffffff);
              const head = this.add.rectangle(0, -30, 16, 16, 0xffe0bd);
              const name = this.add.text(0, 20, p.name, { fontSize: '12px', fontStyle: 'bold', fontFamily: 'monospace' }).setOrigin(0.5);
              container.add([body, head, name]);
              container.setDepth(p.x + p.y);
              playersSprites.current[id] = container;
            } else {
              const sprite = playersSprites.current[id];
              sprite.x = Phaser.Math.Linear(sprite.x, x, 0.1);
              sprite.y = Phaser.Math.Linear(sprite.y, y, 0.1);
              sprite.setDepth(p.x + p.y);

              // Camera follow local player
              if (user && id === user.uid) {
                this.cameras.main.scrollX = Phaser.Math.Linear(this.cameras.main.scrollX, sprite.x - window.innerWidth / (2 * this.cameras.main.zoom), 0.05);
                this.cameras.main.scrollY = Phaser.Math.Linear(this.cameras.main.scrollY, sprite.y - window.innerHeight / (2 * this.cameras.main.zoom), 0.05);
              }
              
              // Chat Bubble
              let bubble = sprite.getByName('bubble') as Phaser.GameObjects.Container;
              if (p.message) {
                if (!bubble) {
                  bubble = this.add.container(0, -60).setName('bubble');
                  const bg = this.add.rectangle(0, 0, 120, 30, 0xffffff).setOrigin(0.5).setStrokeStyle(2, 0x000000);
                  const txt = this.add.text(0, 0, p.message, { color: '#000', fontSize: '12px', fontFamily: 'monospace' }).setOrigin(0.5);
                  bubble.add([bg, txt]);
                  sprite.add(bubble);
                } else {
                  (bubble.list[1] as Phaser.GameObjects.Text).setText(p.message);
                }
              } else if (bubble) {
                bubble.destroy();
              }
            }
          });

          // Cleanup
          Object.keys(playersSprites.current).forEach(id => {
            if (!currentPlayers[id]) {
              playersSprites.current[id].destroy();
              delete playersSprites.current[id];
            }
          });
        }
      }
    };

    gameRef.current = new Phaser.Game(config);

    const handleResize = () => {
      if (gameRef.current) {
        gameRef.current.scale.resize(window.innerWidth, window.innerHeight);
        const scene = gameRef.current.scene.getAt(0);
        if (scene) {
          const zoom = window.innerWidth < 640 ? 1.0 : 1.5;
          scene.cameras.main.setZoom(zoom);
        }
      }
    };
    window.addEventListener('resize', handleResize);

    return () => { 
      window.removeEventListener('resize', handleResize);
      gameRef.current?.destroy(true); 
      gameRef.current = null; 
      playersSprites.current = {};
    };
  }, [user]); // Only recreate if user changes

  const enviarMovimento = (x: number, y: number) => {
    if (user) {
      const playerRef = ref(rtdb, `jogadores/${user.uid}`);
      update(playerRef, { x, y });
    }
  };

  const handleSendChat = (e: React.FormEvent) => {
    e.preventDefault();
    if (chatInput.trim() && user) {
      const playerRef = ref(rtdb, `jogadores/${user.uid}`);
      const chatRef = ref(rtdb, 'mensagens');
      
      // Update player message
      update(playerRef, { message: chatInput });
      
      // Save to global messages
      push(chatRef, {
        uid: user.uid,
        name: user.displayName,
        text: chatInput,
        timestamp: serverTimestamp()
      });

      setChatInput('');
      setTimeout(() => update(playerRef, { message: '' }), 5000);
    }
  };

  if (isAuthLoading) {
    return (
      <div className="h-screen w-full bg-[#1a1a2e] flex items-center justify-center font-mono">
        <div className="text-white text-xl animate-pulse">CARREGANDO INIMIGOS...</div>
      </div>
    );
  }

  return (
    <div className="relative w-full h-screen overflow-hidden font-mono select-none">
      <div id="phaser-game" className="w-full h-full" />
      
      <div className="absolute top-4 left-4 sm:top-6 sm:left-6 z-10 flex flex-col gap-2 sm:gap-4 max-w-[calc(100%-2rem)]">
        <div className="bg-black/80 border-2 border-white/20 p-2 sm:p-3 flex items-center gap-3 text-white backdrop-blur-sm">
          {user.photoURL ? (
            <img src={user.photoURL} className="w-8 h-8 sm:w-10 sm:h-10 border-2 border-white" alt="Avatar" />
          ) : (
            <div className="w-8 h-8 sm:w-10 sm:h-10 border-2 border-white bg-white/10 flex items-center justify-center">
              <User size={16} className="text-white/50" />
            </div>
          )}
          <div className="overflow-hidden">
            <p className="text-[8px] sm:text-[10px] text-white/50 font-bold uppercase">User</p>
            <p className="font-bold text-xs sm:text-sm truncate">{user.displayName || 'Anonymous'}</p>
          </div>
        </div>

        <button onClick={() => setIsVoiceActive(!isVoiceActive)} className={`flex items-center gap-2 sm:gap-3 p-2 sm:p-3 border-2 transition-all backdrop-blur-sm ${isVoiceActive ? 'bg-green-500/40 border-green-500 text-green-400' : 'bg-black/80 border-white/20 text-white/60'}`}>
          <div className={`w-8 h-8 sm:w-10 sm:h-10 flex items-center justify-center ${isVoiceActive ? 'bg-green-500 text-white' : 'bg-white/10'}`}>
            {isVoiceActive ? <Mic size={16} /> : <MicOff size={16} />}
          </div>
          <div className="text-left">
            <p className="text-[8px] sm:text-[10px] font-bold uppercase">Voice</p>
            <p className="text-[10px] sm:text-xs">{isVoiceActive ? 'ON' : 'OFF'}</p>
          </div>
        </button>
      </div>

      <div className="absolute bottom-4 sm:bottom-8 left-1/2 -translate-x-1/2 w-full max-w-md px-4 z-10">
        <form onSubmit={handleSendChat} className="flex gap-1 sm:gap-2">
          <input
            type="text"
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            placeholder="DIGITE ALGO..."
            className="flex-1 bg-black/90 border-2 border-white/20 px-4 sm:px-6 py-3 sm:py-4 text-white text-sm sm:text-base focus:outline-none focus:border-indigo-500 font-mono backdrop-blur-md"
          />
          <button type="submit" className="bg-indigo-600 text-white p-3 sm:p-4 border-b-4 border-indigo-900 hover:bg-indigo-500 active:translate-y-1 active:border-b-0">
            <Send size={20} />
          </button>
        </form>
      </div>
    </div>
  );
}

