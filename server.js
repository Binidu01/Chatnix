// server.js - ULTRA FAST with PERMISSION FIX & AUTH DISABLED
import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import { exec as cpExec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import chokidar from "chokidar";
import net from "net";
import os from "os";
import crypto from "crypto";

const exec = promisify(cpExec);

const app = express();
const server = http.createServer(app);
app.use(express.json());

// ----------------------
// Configuration
// ----------------------
const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const PORT = process.env.PORT || 3001;

const WORKSPACE_BASE_PATH = os.platform() === 'win32' 
    ? path.join(process.env.USERPROFILE || 'C:\\', 'code-server-workspaces')
    : '/tmp/code-server-workspaces';

const FREE_PORT_RANGE = { start: 8080, end: 8100 };
const MONITOR_INTERVAL = 15000;
const ROOM_CLEANUP_DELAY = 120000;
const MAX_CONTAINER_RESTARTS = 3;
const RESTART_BACKOFF_BASE_MS = 2000;
const MAX_ROOMS_TOTAL = 100;

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS?.split(',') || [
  "https://8xqqzs-3000.csb.app",
  "http://localhost:3000",
  "http://localhost:3001",
  "https://8xqqzs-3001.csb.app",
];

// ----------------------
// State
// ----------------------
const state = {
  rooms: new Map(),
  dockerContainers: new Map(),
  fileWatchers: new Map(),
  monitorIntervals: new Map(),
  cleanupTimers: new Map(),
  allocatedPorts: new Set(),
  allocatedPortByRoom: new Map(),
  containerRestartAttempts: new Map(),
};

// ----------------------
// Socket.IO
// ----------------------
const io = new Server(server, {
  pingInterval: 25000,
  pingTimeout: 60000,
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// ----------------------
// Utilities
// ----------------------
function getCurrentTimestamp() {
  return new Date().toISOString();
}

function createSystemMessage(message, type = "system") {
  return {
    username: "system",
    message,
    timestamp: getCurrentTimestamp(),
    type,
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function execSafe(cmd) {
  try {
    const { stdout, stderr } = await exec(cmd);
    if (stderr && !stderr.includes('WARNING') && !stderr.includes('deprecated') && !stderr.includes('succeeded')) {
      console.warn(`⚠️ ${stderr}`);
    }
    return stdout.trim();
  } catch (err) {
    throw err;
  }
}

// ----------------------
// Port Management
// ----------------------
async function getFreePort(start = FREE_PORT_RANGE.start, end = FREE_PORT_RANGE.end) {
  for (let port = start; port <= end; port++) {
    if (state.allocatedPorts.has(port)) continue;
    const inUse = await new Promise((resolve) => {
      const s = net.createServer();
      s.once("error", () => resolve(true));
      s.once("listening", () => s.close(() => resolve(false)));
      s.listen(port);
    });
    if (!inUse) {
      state.allocatedPorts.add(port);
      return port;
    }
  }
  throw new Error(`No free ports available`);
}

function freePort(port) {
  if (!port) return;
  state.allocatedPorts.delete(port);
  const room = Array.from(state.allocatedPortByRoom.entries()).find(
    ([, p]) => p === port
  );
  if (room) state.allocatedPortByRoom.delete(room[0]);
}

// ----------------------
// Docker Management
// ----------------------
async function withRetry(fn, retries = 2, delay = 1000) {
  let lastError;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      console.warn(`⚠️ Attempt ${i + 1}/${retries} failed: ${error.message}`);
      if (i < retries - 1) await sleep(delay);
    }
  }
  throw lastError;
}

async function isContainerRunning(containerName) {
  try {
    const out = await execSafe(`docker ps --filter "name=${containerName}" --format "{{.Status}}"`);
    return out.length > 0;
  } catch (err) {
    console.warn(`⚠️ Could not check container: ${err.message}`);
    return false;
  }
}

async function stopAndRemoveContainer(containerName) {
  const commands = [`docker stop ${containerName}`, `docker rm ${containerName}`];
  for (const command of commands) {
    try {
      await execSafe(command);
    } catch {}
  }
}

// ----------------------
// ULTRA FAST Container Creation - FIXED VERSION
// ----------------------
async function createDockerContainer(roomId, projectPath, port) {
  const containerName = `code-server-${roomId}`;
  
  // Fix Windows path
  let dockerPath = projectPath;
  if (os.platform() === 'win32') {
    dockerPath = projectPath.replace(/\\/g, '/');
    if (!dockerPath.match(/^[A-Za-z]:/)) {
      dockerPath = `C:/${dockerPath}`;
    }
  }

  // Check if directory exists
  try {
    await fs.access(projectPath);
  } catch {
    throw new Error(`Project directory not found: ${projectPath}`);
  }

  // Remove existing container
  try {
    await execSafe(`docker rm -f ${containerName}`);
  } catch {}

  // Use the OFFICIAL code-server image (not LinuxServer.io) - it works better with auth disabled
  const imageTag = 'codercom/code-server:latest';
  
  // Quick image check
  try {
    const imageCheck = await execSafe(`docker images ${imageTag} --format "{{.Repository}}"`);
    if (!imageCheck) {
      console.log(`📥 Pulling official code-server image...`);
      await execSafe(`docker pull ${imageTag}`);
    }
  } catch {
    console.log(`📥 Pulling official code-server image...`);
    await execSafe(`docker pull ${imageTag}`);
  }

  // Use the OFFICIAL image with correct port 8080 and auth disabled
  const dockerCommand = `docker run -d -p ${port}:8080 \
-v "${dockerPath}:/home/coder/project" \
-e PASSWORD="" \
--name ${containerName} \
--restart unless-stopped \
${imageTag} \
--auth none \
--bind-addr 0.0.0.0:8080`;

  console.log(`🐳 Starting container on port ${port}...`);
  
  await execSafe(dockerCommand);
  
  // Wait 5 seconds for container to start
  await sleep(5000);
  
  // Check if container is running
  const running = await isContainerRunning(containerName);
  
  if (!running) {
    try {
      const logs = await execSafe(`docker logs ${containerName} --tail 20`);
      console.error('📋 Container logs:', logs);
    } catch (logErr) {
      console.error('Could not fetch logs');
    }
    throw new Error(`Container ${containerName} failed to start`);
  }

  console.log(`✅ Container ready on port ${port}!`);
  console.log(`🌐 http://localhost:${port}`);
  
  return { containerId: containerName, containerName };
}

// ----------------------
// Project Management
// ----------------------
async function createProjectFolder(roomId) {
  const projectPath = path.join(WORKSPACE_BASE_PATH, roomId);
  const projectDir = path.join(projectPath, "project");

  try {
    await fs.mkdir(projectDir, { recursive: true });

    const INITIAL_FILES = {
      "README.md": `# Room ${roomId}\n\nWelcome!\n`,
      "index.js": `console.log("Hello from room ${roomId}!");\n`,
      "index.html": `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Room ${roomId}</title></head>
<body><h1>Welcome to Room ${roomId}</h1></body>
</html>`,
      "package.json": JSON.stringify({
        name: `room-${roomId}`,
        version: "1.0.0",
        main: "index.js",
        scripts: { start: "node index.js" },
      }, null, 2),
    };

    await Promise.all(
      Object.entries(INITIAL_FILES).map(async ([fileName, content]) => {
        await fs.writeFile(path.join(projectDir, fileName), content);
      })
    );

    console.log(`📁 Project created at: ${projectDir}`);
    return projectPath;
  } catch (error) {
    console.error("❌ Error creating project:", error);
    throw error;
  }
}

// ----------------------
// VS Code Docker Management
// ----------------------
function buildPublicUrlFromBase(port) {
  try {
    const base = new URL(BASE_URL);
    const hostname = base.hostname;
    const lastNumberMatch = hostname.match(/(\d+)(?!.*\d)/);
    if (lastNumberMatch) {
      const newHostname = hostname.slice(0, lastNumberMatch.index) + String(port) + hostname.slice(lastNumberMatch.index + lastNumberMatch[0].length);
      return `${base.protocol}//${newHostname}${base.pathname === "/" ? "" : base.pathname.replace(/\/$/, "")}`;
    } else {
      base.port = String(port);
      return base.toString().replace(/\/$/, "");
    }
  } catch {
    return `http://localhost:${port}`;
  }
}

async function startVSCodeDocker(roomId, projectPath) {
  return withRetry(async () => {
    let port;
    try {
      port = await getFreePort();
      state.allocatedPortByRoom.set(roomId, port);

      console.log(`🚀 Starting room ${roomId} on port ${port}...`);
      
      const { containerId, containerName } = await createDockerContainer(roomId, projectPath, port);
      state.dockerContainers.set(roomId, containerId);

      const url = buildPublicUrlFromBase(port);

      const room = state.rooms.get(roomId);
      if (room) {
        room.vsCodeUrl = url;
        room.projectPath = projectPath;
        room.containerId = containerId;
        room.port = port;
        room.status = 'ready';
        room.readyAt = getCurrentTimestamp();
        state.rooms.set(roomId, room);
      }

      startFileWatcher(roomId, path.join(projectPath, "project"));
      startContainerMonitor(roomId);

      emitToRoom(roomId, "vscode-url", url);

      console.log(`✅ VS Code ready at ${url}`);
      return { containerId, port, url };
    } catch (error) {
      if (port) freePort(port);
      console.error(`❌ Error:`, error.message);
      throw error;
    }
  }, 2, 1000);
}

// ----------------------
// File Watching
// ----------------------
function startFileWatcher(roomId, projectPath) {
  if (state.fileWatchers.has(roomId)) {
    state.fileWatchers.get(roomId).close();
    state.fileWatchers.delete(roomId);
  }

  try {
    const watcher = chokidar.watch(projectPath, {
      ignored: ["**/node_modules/**", "**/.git/**", "**/.vscode/**", "**/.*"],
      persistent: true,
      ignoreInitial: true,
    });

    watcher.on("add", (filePath) => {
      broadcastFileChange(roomId, "created", path.relative(projectPath, filePath));
    });

    watcher.on("change", (filePath) => {
      broadcastFileChange(roomId, "edited", path.relative(projectPath, filePath));
    });

    watcher.on("unlink", (filePath) => {
      broadcastFileChange(roomId, "deleted", path.relative(projectPath, filePath));
    });

    watcher.on("error", (error) => {
      console.error(`🔍 Watcher error:`, error);
    });

    state.fileWatchers.set(roomId, watcher);
  } catch (error) {
    console.error("❌ Error starting watcher:", error);
  }
}

function broadcastFileChange(roomId, action, filePath) {
  const room = state.rooms.get(roomId);
  if (!room) return;

  const systemMsg = createSystemMessage(`Someone ${action} "${filePath}"`, "file-change");
  room.messages.push(systemMsg);
  emitToRoom(roomId, "chat-message", systemMsg);
}

// ----------------------
// Container Monitoring
// ----------------------
function startContainerMonitor(roomId) {
  if (state.monitorIntervals.has(roomId)) {
    clearInterval(state.monitorIntervals.get(roomId));
  }

  state.monitorIntervals.set(roomId, setInterval(async () => {
    try {
      const containerName = state.dockerContainers.get(roomId);
      if (!containerName) return;

      const running = await isContainerRunning(containerName);
      if (!running) {
        console.warn(`⚠️ Container ${roomId} stopped`);

        const attempts = (state.containerRestartAttempts.get(roomId) || 0) + 1;
        state.containerRestartAttempts.set(roomId, attempts);

        if (attempts > MAX_CONTAINER_RESTARTS) {
          console.error(`❌ Room ${roomId} exceeded restart attempts`);
          emitToRoom(roomId, "vscode-url", null);
          await cleanupRoom(roomId);
          return;
        }

        const backoff = RESTART_BACKOFF_BASE_MS * Math.pow(2, attempts - 1);
        setTimeout(() => {
          restartVSCodeDocker(roomId).catch(e => console.error(`❌ Restart failed:`, e));
        }, backoff);
      } else {
        state.containerRestartAttempts.set(roomId, 0);
      }
    } catch (err) {
      console.error("❌ Monitor error:", err);
    }
  }, MONITOR_INTERVAL));
}

async function restartVSCodeDocker(roomId) {
  try {
    console.log(`🔄 Restarting room ${roomId}...`);

    const oldContainerName = state.dockerContainers.get(roomId);
    const oldPort = state.allocatedPortByRoom.get(roomId);

    if (oldContainerName) {
      await stopAndRemoveContainer(oldContainerName);
      state.dockerContainers.delete(roomId);
    }

    if (oldPort) freePort(oldPort);

    const room = state.rooms.get(roomId);
    const projectPath = room?.projectPath || path.join(WORKSPACE_BASE_PATH, roomId);
    
    const { url, containerId, port } = await startVSCodeDocker(roomId, projectPath);

    if (room) {
      room.vsCodeUrl = url;
      room.containerId = containerId;
      room.port = port;
      state.rooms.set(roomId, room);
    }

    emitToRoom(roomId, "vscode-url", url);
    console.log(`✅ Restarted room ${roomId}`);
  } catch (err) {
    console.error(`❌ Restart failed:`, err);
    emitToRoom(roomId, "vscode-url", null);
  }
}

// ----------------------
// Room Management
// ----------------------
async function cleanupRoom(roomId) {
  console.log(`🧹 Cleaning room ${roomId}`);

  if (state.monitorIntervals.has(roomId)) {
    clearInterval(state.monitorIntervals.get(roomId));
    state.monitorIntervals.delete(roomId);
  }

  if (state.fileWatchers.has(roomId)) {
    state.fileWatchers.get(roomId).close();
    state.fileWatchers.delete(roomId);
  }

  const containerName = state.dockerContainers.get(roomId);
  if (containerName) {
    try {
      await stopAndRemoveContainer(containerName);
    } catch (err) {
      console.error(`❌ Error cleaning container:`, err);
    }
    state.dockerContainers.delete(roomId);
  }

  const port = state.allocatedPortByRoom.get(roomId);
  if (port) freePort(port);
  state.allocatedPortByRoom.delete(roomId);

  state.containerRestartAttempts.delete(roomId);
  state.rooms.delete(roomId);

  emitToRoom(roomId, "vscode-url", null);
}

function scheduleRoomCleanup(roomId) {
  if (state.cleanupTimers.has(roomId)) {
    clearTimeout(state.cleanupTimers.get(roomId));
  }

  state.cleanupTimers.set(roomId, setTimeout(async () => {
    const room = state.rooms.get(roomId);
    if (room && room.users.length === 0) {
      await cleanupRoom(roomId);
    }
    state.cleanupTimers.delete(roomId);
  }, ROOM_CLEANUP_DELAY));
}

function cancelRoomCleanup(roomId) {
  if (state.cleanupTimers.has(roomId)) {
    clearTimeout(state.cleanupTimers.get(roomId));
    state.cleanupTimers.delete(roomId);
  }
}

function emitToRoom(roomId, event, data) {
  try {
    io.to(roomId).emit(event, data);
  } catch (err) {
    console.error(`❌ Error emitting:`, err);
  }
}

// ----------------------
// CORS
// ----------------------
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ["GET", "POST", "OPTIONS"],
  credentials: true,
  allowedHeaders: ["Content-Type", "Authorization"],
}));

// ----------------------
// API Endpoints
// ----------------------
app.post("/create-room", async (req, res) => {
  try {
    const { roomId } = req.body;
    if (!roomId) {
      return res.status(400).json({ error: "roomId required", success: false });
    }

    if (state.rooms.size >= MAX_ROOMS_TOTAL) {
      return res.status(429).json({ error: "Maximum rooms reached", success: false, retryAfter: 30 });
    }

    const existingRoom = state.rooms.get(roomId);
    if (existingRoom?.vsCodeUrl) {
      return res.json({ roomId, url: existingRoom.vsCodeUrl, success: true });
    }

    const projectPath = await createProjectFolder(roomId);

    const roomData = {
      messages: [],
      users: [],
      vsCodeUrl: null,
      projectPath,
      containerId: null,
      port: null,
      status: 'creating',
      createdAt: getCurrentTimestamp(),
    };
    state.rooms.set(roomId, roomData);

    startVSCodeDocker(roomId, projectPath).catch((err) => {
      console.error(`❌ Failed:`, err);
      const room = state.rooms.get(roomId);
      if (room) {
        room.status = 'failed';
        room.error = err.message;
        state.rooms.set(roomId, room);
      }
    });

    res.json({
      roomId,
      url: null,
      success: true,
      status: "processing",
      estimatedTime: "5-10 seconds"
    });
  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json({ error: err.message, success: false });
  }
});

app.get("/room/:roomId/status", (req, res) => {
  const room = state.rooms.get(req.params.roomId);
  if (!room) {
    return res.status(404).json({ error: "Room not found", success: false });
  }

  res.json({
    roomId: req.params.roomId,
    status: room.status || 'unknown',
    vsCodeUrl: room.vsCodeUrl || null,
    users: room.users.length,
    ready: !!room.vsCodeUrl,
    success: true,
  });
});

app.get("/project/:roomId/vscode", (req, res) => {
  const room = state.rooms.get(req.params.roomId);
  if (room?.vsCodeUrl) {
    res.json({ vsCodeUrl: room.vsCodeUrl, success: true });
  } else if (room?.status === 'creating') {
    res.status(202).json({ vsCodeUrl: null, status: 'creating', success: true });
  } else {
    res.status(404).json({ error: "Room not ready", success: false });
  }
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    activeRooms: state.rooms.size,
    activeContainers: state.dockerContainers.size,
    uptime: process.uptime(),
    timestamp: getCurrentTimestamp(),
  });
});

// ----------------------
// Socket.IO
// ----------------------
io.on("connection", (socket) => {
  console.log("👤 User connected:", socket.id);

  socket.on("join-room", async (payload) => {
    try {
      const { roomId, username, photoURL } = payload || {};
      if (!username || !roomId) {
        return socket.emit("error", { message: "Username and roomId required" });
      }

      const room = state.rooms.get(roomId);
      if (!room) {
        return socket.emit("error", { message: "Room not found" });
      }

      cancelRoomCleanup(roomId);

      socket.join(roomId);
      socket.username = username;
      socket.roomId = roomId;

      if (!room.users.find((u) => u.username === username)) {
        room.users.push({ username, photoURL, joinedAt: getCurrentTimestamp() });
        state.rooms.set(roomId, room);
      }

      socket.emit("chat-history", room.messages);
      
      if (room.vsCodeUrl) {
        socket.emit("vscode-url", room.vsCodeUrl);
      } else if (room.status === 'creating') {
        socket.emit("room-status", { status: 'creating' });
      }

      emitToRoom(roomId, "users-update", room.users);
      const joinMessage = createSystemMessage(`${username} joined.`, "user-action");
      room.messages.push(joinMessage);
      emitToRoom(roomId, "chat-message", joinMessage);

      console.log(`👤 ${username} joined ${roomId}`);
    } catch (err) {
      console.error("❌ Join error:", err);
      socket.emit("error", { message: "Server error" });
    }
  });

  socket.on("chat-message", (payload) => {
    try {
      const { roomId, username, message, photoURL } = payload || {};
      const room = state.rooms.get(roomId);
      if (!room || !message?.trim()) return;

      const msgObj = {
        username,
        message: message.trim(),
        timestamp: getCurrentTimestamp(),
        photoURL,
        type: "chat",
      };

      room.messages.push(msgObj);
      emitToRoom(roomId, "chat-message", msgObj);
    } catch (err) {
      console.error("❌ Chat error:", err);
    }
  });

  socket.on("disconnecting", async () => {
    try {
      const { roomId, username } = socket;
      const room = state.rooms.get(roomId);

      if (roomId && username && room) {
        room.users = room.users.filter((u) => u.username !== username);
        state.rooms.set(roomId, room);
        emitToRoom(roomId, "users-update", room.users);

        const leaveMessage = createSystemMessage(`${username} left.`, "user-action");
        room.messages.push(leaveMessage);
        emitToRoom(roomId, "chat-message", leaveMessage);

        if (room.users.length === 0) {
          scheduleRoomCleanup(roomId);
        }
      }
    } catch (err) {
      console.error("❌ Disconnect error:", err);
    }
  });
});

// ----------------------
// Shutdown
// ----------------------
async function gracefulShutdown() {
  console.log("🛑 Shutting down...");
  for (const timer of state.monitorIntervals.values()) clearInterval(timer);
  for (const timer of state.cleanupTimers.values()) clearTimeout(timer);
  for (const roomId of Array.from(state.rooms.keys())) {
    await cleanupRoom(roomId);
  }
  process.exit(0);
}

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

// ----------------------
// Start
// ----------------------
async function startServer() {
  try {
    await fs.mkdir(WORKSPACE_BASE_PATH, { recursive: true });
    console.log(`✅ Workspace: ${WORKSPACE_BASE_PATH}`);

    server.listen(PORT, "0.0.0.0", () => {
      console.log("==================================================");
      console.log("🚀 ULTRA FAST CODE SERVER");
      console.log("==================================================");
      console.log(`🌐 http://localhost:${PORT}`);
      console.log(`📁 ${WORKSPACE_BASE_PATH}`);
      console.log(`🐳 Official Code-Server (5-10s startup)`);
      console.log(`🕐 ${getCurrentTimestamp()}`);
      console.log("==================================================");
    });
  } catch (error) {
    console.error("❌ Failed to start:", error);
    process.exit(1);
  }
}

startServer();