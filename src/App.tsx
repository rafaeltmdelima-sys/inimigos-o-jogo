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
  serverTimestamp,
  query,
  limitToLast
} from 'firebase/database';
import { io, Socket } from 'socket.io-client';
import { Send, User, MessageSquare, Mic, MicOff, LogIn, Hand } from 'lucide-react';
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

const cartesianToIso = (x: number, y: number, z: number = 0) => ({
  x: (x - y) * (TILE_WIDTH / 2),
  y: (x + y) * (TILE_HEIGHT / 2) - (z * 16) // 16 pixels height per Z level
});

interface PlayerData {
  id: string;
  x: number;
  y: number;
  z: number;
  color: number;
  name: string;
  message: string;
  grabbedBy?: string;
  isVoiceActive?: boolean;
}

export default function App() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [players, setPlayers] = useState<Record<string, PlayerData>>({});
  const [ball, setBall] = useState<{ x: number, y: number, z: number, vx: number, vy: number }>({ x: 5, y: 5, z: 2, vx: 0, vy: 0 });
  const [chatLog, setChatLog] = useState<{ id: string, name: string, text: string }[]>([]);
  const [isChatLogVisible, setIsChatLogVisible] = useState(true);
  const [chatInput, setChatInput] = useState('');
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [showInstallBtn, setShowInstallBtn] = useState(false);

  const gameRef = useRef<Phaser.Game | null>(null);
  const playersSprites = useRef<Record<string, Phaser.GameObjects.Container>>({});
  const peersRef = useRef<Record<string, Peer.Instance>>({});
  const playersRef = useRef<Record<string, PlayerData>>({});
  const ballRef = useRef<{ x: number, y: number, z: number, vx: number, vy: number }>({ x: 5, y: 5, z: 2, vx: 0, vy: 0 });
  const ballSprite = useRef<Phaser.GameObjects.Arc | null>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);

  // Sync players state to ref for Phaser access
  useEffect(() => {
    playersRef.current = players;
  }, [players]);

  useEffect(() => {
    ballRef.current = ball;
  }, [ball]);

  // Auto-scroll chat to bottom
  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [chatLog]);

  // PWA Install Prompt
  useEffect(() => {
    const handler = (e: any) => {
      e.preventDefault();
      setDeferredPrompt(e);
      setShowInstallBtn(true);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const handleInstall = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      console.log('User accepted the install prompt');
    }
    setDeferredPrompt(null);
    setShowInstallBtn(false);
  };

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
            z: 2, // Top floor
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

    // Ball Listener
    const bolaRef = ref(rtdb, 'bola');
    const unsubscribeBall = onValue(bolaRef, (snapshot) => {
      const data = snapshot.val();
      if (data) {
        setBall({ x: data.x, y: data.y, z: data.z || 0, vx: data.vx, vy: data.vy });
      } else {
        // Initialize ball if not exists
        set(bolaRef, { x: 5, y: 5, z: 2, vx: 0, vy: 0 });
      }
    });

    // Chat History Listener - Increase limit so user can scroll up a bit
    const mensagensRef = query(ref(rtdb, 'mensagens'), limitToLast(30));
    const unsubscribeChat = onValue(mensagensRef, (snapshot) => {
      const data = snapshot.val() || {};
      const messages = Object.entries(data).map(([id, msg]: [string, any]) => ({
        id,
        name: msg.name,
        text: msg.text
      }));
      setChatLog(messages);
    });

    return () => {
      unsubscribe();
      unsubscribeBall();
      unsubscribeChat();
    };
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

          // Draw Isometric Grid (Multi-level)
          const drawTiles = (startX: number, endX: number, startY: number, endY: number, z: number, color: number) => {
            for (let i = startX; i < endX; i++) {
              for (let j = startY; j < endY; j++) {
                const { x, y } = cartesianToIso(i, j, z);
                const points = [0, -16, 32, 0, 0, 16, -32, 0];
                const poly = this.add.polygon(x, y, points, color);
                poly.setStrokeStyle(1, 0x1a1a2e, 0.5);
                poly.setInteractive(new Phaser.Geom.Polygon(points), Phaser.Geom.Polygon.Contains);
                poly.on('pointerdown', () => enviarMovimento(i, j, z));
                poly.on('pointerover', () => poly.setFillStyle(color + 0x111111));
                poly.on('pointerout', () => poly.setFillStyle(color));
                poly.setDepth(i + j + (z * 10) - 100);
              }
            }
          };

          // Level 1: Main Floor (Upper)
          drawTiles(0, 12, 0, 12, 2, 0x242435);

          // Level 2: Lower Floor (Platform 2)
          drawTiles(16, 28, 0, 12, 0, 0x1a1a2e);

          // Stairs (Connecting Bridge)
          for (let i = 12; i < 16; i++) {
            const z = 2 - (i - 12) * 0.5; // Gradual descent
            for (let j = 4; j < 8; j++) {
              const { x, y } = cartesianToIso(i, j, z);
              const points = [0, -16, 32, 0, 0, 16, -32, 0];
              const poly = this.add.polygon(x, y, points, 0x3b3b4f);
              poly.setStrokeStyle(1.5, 0x4f46e5, 0.6);
              poly.setInteractive(new Phaser.Geom.Polygon(points), Phaser.Geom.Polygon.Contains);
              poly.on('pointerdown', () => enviarMovimento(i, j, z));
              poly.setDepth(i + j + (z * 10) - 100);
            }
          }
          
          // Set Camera Bounds
          const totalWidth = 30 * TILE_WIDTH * 2;
          const totalHeight = 15 * TILE_HEIGHT * 2;
          this.cameras.main.setBounds(-totalWidth/2, -totalHeight/2, totalWidth, totalHeight);
          this.cameras.main.centerOn(0, 12 * TILE_HEIGHT / 2);
          
          // Add Ball Sprite
          const ballPos = cartesianToIso(ballRef.current.x, ballRef.current.y, ballRef.current.z);
          ballSprite.current = this.add.circle(ballPos.x, ballPos.y, 12, 0xffffff).setStrokeStyle(2, 0x000000);
          ballSprite.current.setDepth(1000);

          // Responsive zoom
          let initialZoom = 0.7;
          if (window.innerWidth >= 1280) initialZoom = 1.0;
          else if (window.innerWidth >= 640) initialZoom = 1.3;
          this.cameras.main.setZoom(initialZoom);
          
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
            const { x, y } = cartesianToIso(p.x, p.y, p.z || 0);
            
            if (!playersSprites.current[id]) {
              const container = this.add.container(x, y);
              
              // Generic Avatar
              const body = this.add.rectangle(0, -10, 20, 40, p.color).setStrokeStyle(2, 0xffffff);
              const head = this.add.rectangle(0, -30, 16, 16, 0xffe0bd);
              const name = this.add.text(0, 20, p.name, { fontSize: '12px', fontStyle: 'bold', fontFamily: 'monospace' }).setOrigin(0.5).setName('nameTag');
              
              container.add([body, head, name]);
              // Robust depth sorting: x + y determines order within a floor, z * 100 separates floors
              container.setDepth(p.x + p.y + (p.z || 0) * 100);
              playersSprites.current[id] = container;
            } else {
              const container = playersSprites.current[id];
              
              const oldX = container.x;
              const oldY = container.y;
              const { x: isoX, y: isoY } = cartesianToIso(p.x, p.y, p.z || 0);
              
              // Smoother and slower movement
              container.x = Phaser.Math.Linear(container.x, isoX, 0.04);
              container.y = Phaser.Math.Linear(container.y, isoY, 0.04);
              container.setDepth(p.x + p.y + (p.z || 0) * 100);

              // Update name if changed
              const nameTxt = container.getByName('nameTag') as Phaser.GameObjects.Text;
              if (nameTxt && nameTxt.text !== p.name) {
                nameTxt.setText(p.name);
              }

              // Subtle bobbing animation when moving
              const isMoving = Math.abs(container.x - oldX) > 0.1 || Math.abs(container.y - oldY) > 0.1;
              if (isMoving) {
                container.y += Math.sin(this.time.now / 100) * 0.5;
              }

              // Camera follow local player
              if (user && id === user.uid) {
                this.cameras.main.scrollX = Phaser.Math.Linear(this.cameras.main.scrollX, container.x - window.innerWidth / (2 * this.cameras.main.zoom), 0.03);
                this.cameras.main.scrollY = Phaser.Math.Linear(this.cameras.main.scrollY, container.y - window.innerHeight / (2 * this.cameras.main.zoom), 0.03);
              }
              
              // Chat Bubble
              let bubble = container.getByName('bubble') as Phaser.GameObjects.Container;
              if (p.message) {
                if (!bubble) {
                  bubble = this.add.container(0, -60).setName('bubble');
                  // Use a small font and word wrapping for the bubble
                  const txt = this.add.text(0, 0, p.message, { 
                    color: '#000', 
                    fontSize: '11px', 
                    fontFamily: 'monospace',
                    align: 'center',
                    wordWrap: { width: 100 }
                  }).setOrigin(0.5);
                  
                  const bg = this.add.rectangle(0, 0, txt.width + 10, txt.height + 6, 0xffffff)
                    .setOrigin(0.5)
                    .setStrokeStyle(1.5, 0x000000);
                  
                  bubble.add([bg, txt]);
                  // Ensure text stays above background
                  txt.setDepth(1);
                  container.add(bubble);
                } else {
                  const txt = bubble.list[1] as Phaser.GameObjects.Text;
                  const bg = bubble.list[0] as Phaser.GameObjects.Rectangle;
                  if (txt.text !== p.message) {
                    txt.setText(p.message);
                    // Update background size dynamically
                    bg.setSize(txt.width + 10, txt.height + 6);
                    // Adjust container position if it grows
                    bubble.y = -45 - (txt.height / 2);
                  }
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

            // Update Ball
            if (ballSprite.current) {
              const b = ballRef.current;
              const targetPos = cartesianToIso(b.x, b.y, b.z || 0);
              
              // Interpolate ball position
              ballSprite.current.x = Phaser.Math.Linear(ballSprite.current.x, targetPos.x, 0.2);
              ballSprite.current.y = Phaser.Math.Linear(ballSprite.current.y, targetPos.y, 0.2);
              ballSprite.current.setDepth(b.x + b.y + (b.z || 0) * 100 + 1);

            // Local Physics (only for the local player to avoid conflicts)
            if (user) {
              const p = currentPlayers[user.uid];
              if (p) {
                // Handle grabbing logic: if I am grabbing someone, sync their position with a small delay
                Object.values(currentPlayers).forEach(otherP => {
                  if (otherP.grabbedBy === user.uid) {
                    const targetRef = ref(rtdb, `jogadores/${otherP.id}`);
                    // Use Phaser's linear interpolation for the sync logic but locally we just push to RTDB
                    // To get a "delay" effect, we can use a simpler lerp toward current position
                    const lerpX = Phaser.Math.Linear(otherP.x, p.x, 0.1);
                    const lerpY = Phaser.Math.Linear(otherP.y, p.y, 0.1);
                    update(targetRef, { x: lerpX, y: lerpY, z: p.z });
                  }
                });

                const dist = Phaser.Math.Distance.Between(p.x, p.y, b.x, b.y);
                if (dist < 1.0) {
                  // Kick the ball!
                  const angle = Phaser.Math.Angle.Between(p.x, p.y, b.x, b.y);
                  // Heavier feel: lower force (0.3 instead of 0.5)
                  const force = 0.3;
                  const newVx = Math.cos(angle) * force;
                  const newVy = Math.sin(angle) * force;
                  
                  // Update ball in RTDB
                  const bolaRef = ref(rtdb, 'bola');
                  update(bolaRef, { 
                    vx: newVx, 
                    vy: newVy,
                    x: b.x + newVx * 0.5, // Small nudge to prevent getting stuck
                    y: b.y + newVy * 0.5
                  });
                }
              }
            }

            // Ball friction and movement (simulated locally for smoothness, but synced)
            if (Math.abs(b.vx) > 0.005 || Math.abs(b.vy) > 0.005) {
              const friction = 0.92;
              let nextX = b.x + b.vx;
              let nextY = b.y + b.vy;
              let nextVx = b.vx * friction;
              let nextVy = b.vy * friction;
              let nextZ = b.z;

              // Boundary Box logic based on current section
              const margin = 0.2;
              
              const isUpper = nextX <= 12;
              const isLower = nextX >= 16;
              const isStairs = nextX > 12 && nextX < 16 && nextY >= 4 && nextY <= 8;

              if (isUpper) {
                // Bounds for upper floor
                if (nextX < margin) { nextX = margin; nextVx *= -0.6; }
                if (nextY < margin) { nextY = margin; nextVy *= -0.6; }
                if (nextY > 12 - margin) { nextY = 12 - margin; nextVy *= -0.6; }
                // Fall off edge if not aligned with stairs
                if (nextX > 12 - margin && (nextY < 4 || nextY > 8)) {
                  nextX = 12 - margin; nextVx *= -0.6;
                }
                nextZ = 2;
              } else if (isLower) {
                // Bounds for lower floor
                if (nextX > 28 - margin) { nextX = 28 - margin; nextVx *= -0.6; }
                if (nextY < margin) { nextY = margin; nextVy *= -0.6; }
                if (nextY > 12 - margin) { nextY = 12 - margin; nextVy *= -0.6; }
                // Edge check for stairs
                if (nextX < 16 + margin && (nextY < 4 || nextY > 8)) {
                  nextX = 16 + margin; nextVx *= -0.6;
                }
                nextZ = 0;
              } else if (isStairs) {
                // Bounds for stairs
                if (nextY < 4 + margin) { nextY = 4 + margin; nextVy *= -0.6; }
                if (nextY > 8 - margin) { nextY = 8 - margin; nextVy *= -0.6; }
                nextZ = 2 - (nextX - 12) * 0.5;
              } else {
                // Fallback / Bounce back to upper if lost
                nextX = 11.5; nextVx *= -1;
              }

              // Only update RTDB if we are the "active" physics handler (first player in list)
              const firstPlayerId = Object.keys(currentPlayers).sort()[0];
              if (user && user.uid === firstPlayerId) {
                const bolaRef = ref(rtdb, 'bola');
                update(bolaRef, { 
                  x: nextX, 
                  y: nextY, 
                  z: nextZ,
                  vx: nextVx, 
                  vy: nextVy 
                });
              }
            } else if (Math.abs(b.vx) > 0 || Math.abs(b.vy) > 0) {
              // Stop completely if very slow
              const firstPlayerId = Object.keys(currentPlayers).sort()[0];
              if (user && user.uid === firstPlayerId) {
                const bolaRef = ref(rtdb, 'bola');
                update(bolaRef, { vx: 0, vy: 0 });
              }
            }
          }
        }
      }
    };

    gameRef.current = new Phaser.Game(config);

    const handleResize = () => {
      if (gameRef.current) {
        gameRef.current.scale.resize(window.innerWidth, window.innerHeight);
        const scene = gameRef.current.scene.getAt(0);
        if (scene) {
          // Dynamic zoom: mobile still 0.7, medium screens 1.2, large screens 1.0 (to see more of the map)
          let zoom = 0.7;
          if (window.innerWidth >= 1280) zoom = 1.0;
          else if (window.innerWidth >= 640) zoom = 1.3;
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

  const enviarMovimento = (x: number, y: number, z: number) => {
    if (user) {
      // USE REF to avoid closure staleness
      const currentPlayers = playersRef.current;
      const currentPlayer = currentPlayers[user.uid];
      if (!currentPlayer) return;
      if (currentPlayer.grabbedBy) return; // Can't move while grabbed!

      // Teleport Constraint: Must use stairs to switch floors
      const isTargetStairs = x >= 12 && x <= 16;
      const isCurrentStairs = currentPlayer.x >= 12 && currentPlayer.x <= 16;
      
      if (Math.abs(currentPlayer.z - z) > 0.1) {
        if (!isTargetStairs && !isCurrentStairs) {
          return;
        }
      }

      const playerRef = ref(rtdb, `jogadores/${user.uid}`);
      update(playerRef, { x, y, z });
    }
  };

  const handleGrab = () => {
    if (!user) return;
    const me = players[user.uid];
    if (me) {
      // Find closest player within radius
      let closestDist = 1.5; 
      let targetId = null;

      Object.values(players).forEach(p => {
        if (p.id === user.uid) return;
        const dist = Math.sqrt(Math.pow(p.x - me.x, 2) + Math.pow(p.y - me.y, 2));
        if (dist < closestDist) {
          closestDist = dist;
          targetId = p.id;
        }
      });

      if (targetId) {
        const targetRef = ref(rtdb, `jogadores/${targetId}`);
        update(targetRef, { grabbedBy: user.uid });
        
        // Auto-release after 5 seconds
        setTimeout(() => {
          update(targetRef, { grabbedBy: null });
        }, 5000);
      }
    }
  };

  const handleSendChat = (e: React.FormEvent) => {
    e.preventDefault();
    if (chatInput.trim() && user) {
      const playerRef = ref(rtdb, `jogadores/${user.uid}`);
      const chatRef = ref(rtdb, 'mensagens');
      const currentPlayer = players[user.uid];
      const displayName = currentPlayer?.name || user.displayName || 'Anonymous';

      // Check for commands
      if (chatInput.startsWith('/name ')) {
        const newName = chatInput.substring(6).trim();
        if (newName) {
          update(playerRef, { name: newName });
          setChatInput('');
          return;
        }
      }

      if (chatInput.trim().toLowerCase() === '/home') {
        update(playerRef, { x: 5, y: 5, z: 2 });
        setChatInput('');
        return;
      }

      if (chatInput.trim().toLowerCase() === '/grab') {
        handleGrab();
        setChatInput('');
        return;
      }
      
      // Update player message bubble
      update(playerRef, { message: chatInput });
      
      // Save to global messages
      push(chatRef, {
        uid: user.uid,
        name: displayName,
        text: chatInput,
        timestamp: serverTimestamp()
      });

      setChatInput('');
      setTimeout(() => {
        // Check if DB exists before clearing
        update(playerRef, { message: '' });
      }, 5000);
    }
  };

  if (isAuthLoading) {
    return (
      <div className="h-screen w-full bg-[#1a1a2e] flex items-center justify-center font-mono">
        <div className="text-white text-xl animate-pulse">LOADING...</div>
      </div>
    );
  }

  return (
    <div className="relative w-full h-screen overflow-hidden font-mono select-none bg-[#0f0f1a]">
      <div id="phaser-game" className="w-full h-full" />
      
      <div className="absolute top-2 left-2 sm:top-6 sm:left-6 z-10 flex flex-col gap-2 sm:gap-4 max-w-[calc(100%-1rem)]">
        <div className="flex gap-2 items-start">
          <div className="bg-black/80 border sm:border-2 border-white/20 p-1.5 sm:p-3 flex items-center gap-2 sm:gap-4 text-white backdrop-blur-sm shadow-2xl">
            {user.photoURL ? (
              <img src={user.photoURL} className="w-6 h-6 sm:w-12 sm:h-12 border sm:border-2 border-white" alt="Avatar" referrerPolicy="no-referrer" />
            ) : (
              <div className="w-6 h-6 sm:w-12 sm:h-12 border sm:border-2 border-white bg-white/10 flex items-center justify-center">
                <User size={12} className="text-white/50 sm:size-6" />
              </div>
            )}
            <div className="overflow-hidden">
              <p className="text-[7px] sm:text-[11px] text-white/50 font-bold uppercase hidden sm:block">User</p>
              <p className="font-bold text-[10px] sm:text-lg truncate max-w-[70px] sm:max-w-[200px]">
                {players[user.uid]?.name || user.displayName || 'Anonymous'}
              </p>
            </div>
          </div>

          <button onClick={() => setIsVoiceActive(!isVoiceActive)} className={`flex items-center gap-2 p-1.5 sm:p-3 border sm:border-2 transition-all backdrop-blur-sm shadow-2xl ${isVoiceActive ? 'bg-green-500/40 border-green-500 text-green-400' : 'bg-black/80 border-white/20 text-white/60'}`}>
            <div className={`w-6 h-6 sm:w-12 sm:h-12 flex items-center justify-center ${isVoiceActive ? 'bg-green-500 text-white' : 'bg-white/10'}`}>
              {isVoiceActive ? <Mic size={14} className="sm:size-6" /> : <MicOff size={14} className="sm:size-6" />}
            </div>
            <div className="text-left hidden sm:block">
              <p className="text-[8px] sm:text-[11px] font-bold uppercase">Voice</p>
              <p className="text-[10px] sm:text-xs font-bold">{isVoiceActive ? 'ON' : 'OFF'}</p>
            </div>
          </button>
          
          <button 
            onClick={() => setIsChatLogVisible(!isChatLogVisible)}
            className={`sm:hidden bg-black/80 border border-white/20 p-1.5 text-white/60 flex items-center justify-center w-9 h-9 active:bg-white/10 shadow-xl`}
          >
            <MessageSquare size={16} className={isChatLogVisible ? 'text-indigo-400' : ''} />
          </button>

          <button 
            onClick={handleGrab}
            className="sm:hidden bg-indigo-600 border border-white/20 p-1.5 text-white flex items-center justify-center w-9 h-9 active:bg-indigo-500 shadow-xl"
            title="Grab"
          >
            <Hand size={16} />
          </button>
        </div>

        <div className={`${isChatLogVisible ? 'flex' : 'hidden'} sm:flex bg-black/40 border sm:border-2 border-white/10 p-2 sm:p-4 backdrop-blur-[2px] flex-col gap-2 max-h-[120px] sm:max-h-[300px] overflow-hidden w-full sm:w-96 hover:bg-black/60 transition-colors shadow-2xl`}>
          <div className="flex items-center justify-between border-b border-white/10 pb-1 mb-1">
            <div className="flex items-center gap-2">
              <MessageSquare size={12} className="text-indigo-400 sm:size-4" />
              <p className="text-[9px] sm:text-[11px] font-bold text-white/40 uppercase tracking-widest">Chat Log</p>
            </div>
          </div>
          <div 
            ref={chatScrollRef}
            className="flex flex-col gap-1 overflow-y-auto scrollbar-hide scroll-smooth"
          >
            {chatLog.length === 0 ? (
              <p className="text-[9px] text-white/30 italic">No messages...</p>
            ) : (
              chatLog.map((msg) => (
                <div key={msg.id} className="text-[10px] sm:text-sm break-words">
                  <span className="text-indigo-400 font-bold">{msg.name}: </span>
                  <span className="text-white/70">{msg.text}</span>
                </div>
              ))
            )}
          </div>
        </div>

        {showInstallBtn && (
          <button 
            onClick={handleInstall}
            className="bg-indigo-600 text-white p-3 border-2 border-white/20 flex items-center gap-3 hover:bg-indigo-500 transition-all animate-bounce"
          >
            <div className="w-10 h-10 bg-white/20 flex items-center justify-center">
              <LogIn size={20} />
            </div>
            <div className="text-left pr-4">
              <p className="text-[10px] font-bold uppercase">App</p>
              <p className="text-xs font-bold">INSTALAR JOGO</p>
            </div>
          </button>
        )}
      </div>

      <div className="absolute bottom-4 sm:bottom-8 left-1/2 -translate-x-1/2 w-full max-w-[95vw] sm:max-w-xl px-2 sm:px-4 z-10">
        <form onSubmit={handleSendChat} className="flex gap-1 sm:gap-2">
          <input
            type="text"
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            maxLength={60}
            placeholder="DIGITE ALGO..."
            className="flex-1 bg-black/95 border border-white/20 px-3 sm:px-6 py-2.5 sm:py-5 text-white text-[13px] sm:text-lg focus:outline-none focus:border-indigo-500 font-mono backdrop-blur-md shadow-2xl rounded-none appearance-none"
          />
          <button type="submit" className="bg-indigo-600 text-white px-4 sm:px-8 py-2.5 sm:py-5 border-b-4 border-indigo-900 hover:bg-indigo-500 active:translate-y-1 active:border-b-0 transition-all font-bold">
            <Send size={18} className="sm:size-6" />
          </button>
        </form>
      </div>
    </div>
  );
}

