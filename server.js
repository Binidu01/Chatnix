// server.js
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

const exec = promisify(cpExec);

const app = express();
const server = http.createServer(app);
app.use(express.json());

// ----------------------
// Config
// ----------------------
const BASE_URL = process.env.BASE_URL || "https://8xqqzs-3000.csb.app/";
const PORT = process.env.PORT || 3001;
const WORKSPACE_BASE_PATH = "/tmp/code-server-workspaces";
const FREE_PORT_RANGE = { start: 8080, end: 8100 };
const MONITOR_INTERVAL = 10000; // 10 seconds
const ROOM_CLEANUP_DELAY = 60000; // 1 minute
const MAX_CONTAINER_RESTARTS = 5; // fail after this many restarts
const RESTART_BACKOFF_BASE_MS = 2000; // exponential backoff base

// Allowed origins for CORS
const ALLOWED_ORIGINS = [
  "https://8xqqzs-3000.csb.app",
  "http://localhost:3000",
  "http://localhost:3001",
  "https://8xqqzs-3001.csb.app",
];

// File watcher configuration
const WATCHER_CONFIG = {
  ignored: ["**/node_modules/**", "**/.git/**", "**/.vscode/**", "**/.*"],
  persistent: true,
  ignoreInitial: true,
};

// Initial project files template
const INITIAL_FILES = {
  "README.md": (roomId) =>
    `# Room ${roomId}\n\nWelcome to your collaborative coding room!\n`,
  "index.js": (roomId) => `console.log("Hello from room ${roomId}!");\n`,
  "index.html": (roomId) => `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Room ${roomId}</title></head>
<body><h1>Welcome to Room ${roomId}</h1><script src="index.js"></script></body>
</html>`,
  "package.json": (roomId) =>
    JSON.stringify(
      {
        name: `room-${roomId}`,
        version: "1.0.0",
        main: "index.js",
        scripts: { start: "node index.js" },
      },
      null,
      2
    ),
};

// ----------------------
// State Management
// ----------------------
const state = {
  rooms: {}, // roomId -> { messages, users, vsCodeUrl, projectPath, createdAt }
  dockerContainers: {}, // roomId -> containerId
  fileWatchers: {}, // roomId -> chokidar watcher
  monitorIntervals: {}, // roomId -> intervalId
  cleanupTimers: {}, // roomId -> timeoutId
  allocatedPorts: new Set(), // ports reserved
  allocatedPortByRoom: {}, // roomId -> port
  containerRestartAttempts: {}, // roomId -> attempts
};

// ----------------------
// Initialize workspace
// ----------------------
async function initializeWorkspace() {
  try {
    await fs.mkdir(WORKSPACE_BASE_PATH, { recursive: true });
    console.log(`✅ Workspace directory initialized: ${WORKSPACE_BASE_PATH}`);
  } catch (error) {
    console.error("❌ Error creating workspace directory:", error);
    process.exit(1);
  }
}

// ----------------------
// Socket.IO - create early with heartbeat settings
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
// Utility Functions
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

/**
 * Build a public URL from BASE_URL and a port.
 * Strategy:
 *  - Try to replace the last numeric chunk in hostname with port (handles hosts like myhost-3000.example)
 *  - Otherwise set base.port = port
 */
function buildPublicUrlFromBase(port) {
  try {
    const base = new URL(BASE_URL);
    const hostname = base.hostname;
    const lastNumberMatch = hostname.match(/(\d+)(?!.*\d)/); // last numeric run
    let newHostname = hostname;
    if (lastNumberMatch) {
      // replace that numeric run with the port
      newHostname =
        hostname.slice(0, lastNumberMatch.index) +
        String(port) +
        hostname.slice(lastNumberMatch.index + lastNumberMatch[0].length);
      // Rebuild origin with new hostname
      const url = `${base.protocol}//${newHostname}${
        base.pathname === "/" ? "" : base.pathname.replace(/\/$/, "")
      }`;
      return url;
    } else {
      // fallback: set port on URL
      base.port = String(port);
      return base.toString().replace(/\/$/, ""); // trim trailing slash
    }
  } catch (err) {
    console.error("Error building public URL from BASE_URL:", err);
    return `http://localhost:${port}`;
  }
}

/**
 * Reserve and return a free port from the range. Uses state.allocatedPorts to avoid race conditions
 */
async function getFreePort(
  start = FREE_PORT_RANGE.start,
  end = FREE_PORT_RANGE.end
) {
  for (let port = start; port <= end; port++) {
    if (state.allocatedPorts.has(port)) continue;
    const inUse = await new Promise((resolve) => {
      const s = net.createServer();
      s.once("error", () => resolve(true));
      s.once("listening", () => s.close(() => resolve(false)));
      s.listen(port);
    });
    if (!inUse) {
      // reserve the port
      state.allocatedPorts.add(port);
      return port;
    }
  }
  throw new Error(`No free ports available in range ${start}-${end}`);
}

function freePort(port) {
  if (!port) return;
  state.allocatedPorts.delete(port);
  // also remove from allocatedPortByRoom if present
  const room = Object.keys(state.allocatedPortByRoom).find(
    (r) => state.allocatedPortByRoom[r] === port
  );
  if (room) delete state.allocatedPortByRoom[room];
}

async function execSafe(cmd) {
  try {
    const { stdout } = await exec(cmd);
    return stdout.trim();
  } catch (err) {
    throw err;
  }
}

// ----------------------
// Docker Management
// ----------------------
async function isContainerRunning(containerId) {
  try {
    const out = await execSafe(
      `docker inspect -f '{{.State.Running}}' ${containerId}`
    );
    return out === "true";
  } catch (err) {
    return false;
  }
}

async function stopAndRemoveContainer(containerId) {
  const commands = [`docker stop ${containerId}`, `docker rm ${containerId}`];
  for (const command of commands) {
    try {
      await execSafe(command);
    } catch (err) {
      // ignore - might already be stopped/removed
    }
  }
}

async function createDockerContainer(roomId, projectPath, port) {
  const containerName = `code-server-${roomId}-${Date.now()}`;

  // launch code-server in container, binding container:8080 -> host:port
  const dockerCommand = `docker run -d -p ${port}:8080 \
-v ${projectPath}:/home/coder/project \
-e PASSWORD="" \
--name ${containerName} \
codercom/code-server:latest \
--auth none \
--bind-addr 0.0.0.0:8080`;

  const stdout = await execSafe(dockerCommand);
  const containerId = stdout.trim();
  return { containerId, containerName };
}

// ----------------------
// Project Management
// ----------------------
async function createProjectFolder(roomId) {
  const projectPath = path.join(WORKSPACE_BASE_PATH, roomId);
  const projectDir = path.join(projectPath, "project");

  try {
    await fs.mkdir(projectDir, { recursive: true });

    // Create initial files using template
    const fileCreationPromises = Object.entries(INITIAL_FILES).map(
      async ([fileName, contentFn]) => {
        const content = contentFn(roomId);
        const filePath = path.join(projectDir, fileName);
        await fs.writeFile(filePath, content);
      }
    );

    await Promise.all(fileCreationPromises);

    console.log(`📁 Project folder created: ${projectPath}`);
    return projectPath;
  } catch (error) {
    console.error("❌ Error creating project folder:", error);
    throw error;
  }
}

// ----------------------
// File Watching System
// ----------------------
function startFileWatcher(roomId, projectPath) {
  try {
    const watcher = chokidar.watch(projectPath, WATCHER_CONFIG);

    const events = [
      { event: "add", action: "created", type: "file" },
      { event: "change", action: "edited", type: "file" },
      { event: "unlink", action: "deleted", type: "file" },
      { event: "addDir", action: "created", type: "folder" },
      { event: "unlinkDir", action: "deleted", type: "folder" },
    ];

    events.forEach(({ event, action, type }) => {
      watcher.on(event, (filePath) => {
        const relativePath = path.relative(projectPath, filePath);
        broadcastFileChange(roomId, action, relativePath, type);
      });
    });

    watcher.on("error", (error) => {
      console.error(`🔍 File watcher error for room ${roomId}:`, error);
    });

    state.fileWatchers[roomId] = watcher;
    console.log(`🔍 File watcher started for room: ${roomId}`);
  } catch (error) {
    console.error("❌ Error starting file watcher:", error);
  }
}

function stopFileWatcher(roomId) {
  const watcher = state.fileWatchers[roomId];
  if (!watcher) return;
  try {
    watcher.close();
    delete state.fileWatchers[roomId];
    console.log(`🔍 File watcher closed for room: ${roomId}`);
  } catch (err) {
    console.error(`❌ Error closing file watcher for room ${roomId}:`, err);
  }
}

function broadcastFileChange(roomId, action, filePath, type = "file") {
  if (!state.rooms[roomId]) return;

  try {
    const systemMsg = createSystemMessage(
      `Someone ${action} ${type} "${filePath}"`,
      "file-change"
    );
    state.rooms[roomId].messages.push(systemMsg);
    emitToRoom(roomId, "chat-message", systemMsg);
  } catch (error) {
    console.error("❌ Error broadcasting file change:", error);
  }
}

// ----------------------
// Container Monitoring with backoff and retry cap
// ----------------------
async function startContainerMonitor(roomId) {
  // Clear existing interval if present
  if (state.monitorIntervals[roomId]) {
    clearInterval(state.monitorIntervals[roomId]);
  }

  state.monitorIntervals[roomId] = setInterval(async () => {
    try {
      const containerId = state.dockerContainers[roomId];
      if (!containerId) return;

      const running = await isContainerRunning(containerId);
      if (!running) {
        console.warn(
          `⚠️ Container ${containerId} for room ${roomId} is not running.`
        );

        // increment attempts
        state.containerRestartAttempts[roomId] =
          (state.containerRestartAttempts[roomId] || 0) + 1;
        const attempts = state.containerRestartAttempts[roomId];

        if (attempts > MAX_CONTAINER_RESTARTS) {
          console.error(
            `❌ Container for room ${roomId} exceeded restart attempts (${attempts}). Giving up and notifying clients.`
          );
          emitToRoom(roomId, "vscode-url", null);
          // free any reserved port
          const port = state.allocatedPortByRoom[roomId];
          freePort(port);
          // stop monitor to avoid repeated spam
          stopContainerMonitor(roomId);
          return;
        }

        // backoff delay before restart
        const backoff = RESTART_BACKOFF_BASE_MS * Math.pow(2, attempts - 1);
        console.log(
          `🔁 Restart attempt ${attempts} for room ${roomId} in ${backoff}ms`
        );
        setTimeout(() => {
          restartVSCodeDocker(roomId).catch((e) => {
            console.error(
              `❌ restartVSCodeDocker error for room ${roomId}:`,
              e
            );
          });
        }, backoff);
      } else {
        // reset attempts if running ok
        state.containerRestartAttempts[roomId] = 0;
      }
    } catch (err) {
      console.error("❌ Error in container monitor:", err);
    }
  }, MONITOR_INTERVAL);
}

function stopContainerMonitor(roomId) {
  if (state.monitorIntervals[roomId]) {
    clearInterval(state.monitorIntervals[roomId]);
    delete state.monitorIntervals[roomId];
    console.log(`⏹️ Monitor stopped for room ${roomId}`);
  }
}

// ----------------------
// VS Code Docker Management
// ----------------------
async function startVSCodeDocker(roomId, projectPath) {
  let port;
  try {
    port = await getFreePort();
    // temporarily record allocation in case of failure
    state.allocatedPortByRoom[roomId] = port;

    const { containerId, containerName } = await createDockerContainer(
      roomId,
      projectPath,
      port
    );

    state.dockerContainers[roomId] = containerId;

    const url = buildPublicUrlFromBase(port);

    console.log("--------------------------------------------------");
    console.log(`✅ VS Code server started for room: ${roomId}`);
    console.log(`🐳 Container ID : ${containerId}`);
    console.log(`📦 Container Name: ${containerName}`);
    console.log(`🌐 Access URL   : ${url}`);
    console.log("--------------------------------------------------");

    // Initialize room if it doesn't exist
    if (!state.rooms[roomId]) {
      state.rooms[roomId] = {
        messages: [],
        users: [],
        vsCodeUrl: null,
        projectPath,
        createdAt: getCurrentTimestamp(),
      };
    }

    state.rooms[roomId].vsCodeUrl = url;
    state.rooms[roomId].projectPath = projectPath;

    // Start monitoring and file watching
    startFileWatcher(roomId, path.join(projectPath, "project"));
    await startContainerMonitor(roomId);

    // Emit URL to room
    emitToRoom(roomId, "vscode-url", url);

    return { containerId, port, url };
  } catch (error) {
    // free port reservation on failure
    if (port) freePort(port);
    console.error("❌ Error starting VS Code Docker:", error);
    throw error;
  }
}

async function restartVSCodeDocker(roomId) {
  try {
    console.log(`🔄 Restarting VS Code Docker for room ${roomId}...`);

    const oldContainerId = state.dockerContainers[roomId];
    const oldPort = state.allocatedPortByRoom[roomId];

    if (oldContainerId) {
      console.log(
        `🛑 Stopping old container ${oldContainerId} for room ${roomId}`
      );
      await stopAndRemoveContainer(oldContainerId);
      delete state.dockerContainers[roomId];
    }

    // free old port reservation (we will allocate a fresh one)
    if (oldPort) {
      freePort(oldPort);
    }

    const projectPath =
      state.rooms[roomId]?.projectPath ||
      path.join(WORKSPACE_BASE_PATH, roomId);
    const { url, containerId, port } = await startVSCodeDocker(
      roomId,
      projectPath
    );

    state.rooms[roomId].vsCodeUrl = url;
    state.dockerContainers[roomId] = containerId;
    state.allocatedPortByRoom[roomId] = port;

    emitToRoom(roomId, "vscode-url", url);
    console.log(`✅ Restarted VS Code for room ${roomId}: ${url}`);
  } catch (err) {
    console.error(
      `❌ Failed to restart VS Code Docker for room ${roomId}:`,
      err
    );
    emitToRoom(roomId, "vscode-url", null);
  }
}

// ----------------------
// Room Management
// ----------------------
async function cleanupRoom(roomId) {
  console.log(`🧹 Cleaning up room: ${roomId}`);

  // Stop monitoring
  stopContainerMonitor(roomId);

  // Close file watcher
  stopFileWatcher(roomId);

  // Stop and remove Docker container
  if (state.dockerContainers[roomId]) {
    const containerId = state.dockerContainers[roomId];
    try {
      await stopAndRemoveContainer(containerId);
      console.log(`🐳 Docker container cleaned up for room: ${roomId}`);
    } catch (err) {
      console.error(
        `❌ Error cleaning up Docker container for room ${roomId}:`,
        err
      );
    }
    delete state.dockerContainers[roomId];
  }

  // Free reserved port if any
  const port = state.allocatedPortByRoom[roomId];
  if (port) freePort(port);

  // Clear restart attempts
  delete state.containerRestartAttempts[roomId];

  // Notify room about cleanup
  emitToRoom(roomId, "vscode-url", null);
}

function scheduleRoomCleanup(roomId) {
  // cancel existing timer if any
  if (state.cleanupTimers[roomId]) {
    clearTimeout(state.cleanupTimers[roomId]);
  }

  state.cleanupTimers[roomId] = setTimeout(async () => {
    const room = state.rooms[roomId];
    if (room && room.users.length === 0) {
      console.log(`🗑️ Cleaning up empty room: ${roomId}`);
      try {
        await cleanupRoom(roomId);
      } catch (err) {
        console.error(`❌ Error during cleanup of room ${roomId}:`, err);
      }
      delete state.rooms[roomId];
    }
    delete state.cleanupTimers[roomId];
  }, ROOM_CLEANUP_DELAY);
}

function cancelRoomCleanup(roomId) {
  if (state.cleanupTimers[roomId]) {
    clearTimeout(state.cleanupTimers[roomId]);
    delete state.cleanupTimers[roomId];
    console.log(`🛑 Cancelled scheduled cleanup for room: ${roomId}`);
  }
}

// ----------------------
// Socket Utilities
// ----------------------
function emitToRoom(roomId, event, data) {
  try {
    io.to(roomId).emit(event, data);
  } catch (err) {
    console.error(`❌ Error emitting ${event} to room ${roomId}:`, err);
  }
}

// ----------------------
// CORS Configuration
// ----------------------
const corsOptions = {
  origin: ALLOWED_ORIGINS,
  methods: ["GET", "POST", "OPTIONS"],
  credentials: true,
  allowedHeaders: ["Content-Type", "Authorization"],
};
app.use(cors(corsOptions));

// ----------------------
// REST API Endpoints
// ----------------------
app.post("/create-room", async (req, res) => {
  console.log("📨 POST /create-room - Request received:", req.body);

  try {
    const { roomId } = req.body;

    if (!roomId) {
      console.error("❌ Missing roomId in request");
      return res
        .status(400)
        .json({ error: "roomId is required", success: false });
    }

    // Check if room already exists
    if (state.rooms[roomId]?.vsCodeUrl) {
      console.log(`✅ Room ${roomId} already exists`);
      return res.json({
        roomId,
        url: state.rooms[roomId].vsCodeUrl,
        success: true,
        message: "Room already exists",
      });
    }

    console.log(`🚀 Creating room: ${roomId}`);
    const projectPath = await createProjectFolder(roomId);

    // Initialize room
    state.rooms[roomId] = {
      messages: [],
      users: [],
      vsCodeUrl: null,
      createdAt: getCurrentTimestamp(),
      projectPath,
    };

    console.log(`🐳 Starting VS Code Docker for room: ${roomId}`);
    const { url } = await startVSCodeDocker(roomId, projectPath);
    state.rooms[roomId].vsCodeUrl = url;

    console.log(`✅ Room created successfully: ${roomId}`);
    res.json({
      roomId,
      url,
      success: true,
      message: "Room created successfully",
    });
  } catch (err) {
    console.error("❌ Error creating room:", err);
    res.status(500).json({
      error: "Failed to create room",
      details: err.message,
      success: false,
    });
  }
});

app.get("/project/:roomId/vscode", (req, res) => {
  const { roomId } = req.params;
  console.log(`📨 GET /project/${roomId}/vscode`);

  const room = state.rooms[roomId];
  if (room?.vsCodeUrl) {
    res.json({ vsCodeUrl: room.vsCodeUrl, success: true });
  } else {
    console.log(`❌ Room ${roomId} not found or VS Code not ready`);
    res
      .status(404)
      .json({ error: "Room not found or VS Code not ready", success: false });
  }
});

app.get("/health", (req, res) => {
  const healthData = {
    status: "ok",
    activeRooms: Object.keys(state.rooms).length,
    activeContainers: Object.keys(state.dockerContainers).length,
    uptime: process.uptime(),
    timestamp: getCurrentTimestamp(),
  };

  console.log("💊 Health check:", healthData);
  res.json(healthData);
});

app.get("/test", (req, res) => {
  res.json({ message: "Server is working!", timestamp: getCurrentTimestamp() });
});

// ----------------------
// Socket.IO Event Handlers
// ----------------------
io.on("connection", (socket) => {
  console.log("👤 User connected:", socket.id);

  socket.on("join-room", async (payload) => {
    try {
      const { roomId, username, photoURL } = payload || {};
      if (!username || !roomId) {
        console.error("❌ Missing username or roomId");
        return socket.emit("error", {
          message: "Username and roomId required",
        });
      }

      if (!state.rooms[roomId]) {
        console.error(`❌ Room ${roomId} not found`);
        return socket.emit("error", { message: "Room not found" });
      }

      // If there was a scheduled cleanup for this room, cancel it (user rejoined)
      cancelRoomCleanup(roomId);

      socket.join(roomId);
      socket.username = username;
      socket.roomId = roomId;

      // Add user if not already present
      const room = state.rooms[roomId];
      if (!room.users.find((u) => u.username === username)) {
        room.users.push({ username, photoURL });
      }

      // Send initial data to user
      socket.emit("chat-history", room.messages);
      socket.emit("vscode-url", room.vsCodeUrl);

      // Broadcast user updates and join message
      emitToRoom(roomId, "users-update", room.users);
      const joinMessage = createSystemMessage(
        `${username} joined the room.`,
        "user-action"
      );
      room.messages.push(joinMessage);
      emitToRoom(roomId, "chat-message", joinMessage);

      console.log(`👤 User ${username} joined room ${roomId}`);
    } catch (err) {
      console.error("❌ Error in join-room handler:", err);
      socket.emit("error", { message: "Server error during join-room" });
    }
  });

  socket.on("chat-message", (payload) => {
    try {
      const { roomId, username, message, photoURL } = payload || {};
      console.log(
        `💬 Chat message from ${username} in room ${roomId}: ${message}`
      );

      const room = state.rooms[roomId];
      if (!room) {
        console.error(`❌ Room ${roomId} not found for chat message`);
        return;
      }

      if (!message?.trim()) {
        console.error("❌ Empty message received");
        return;
      }

      const msgObj = {
        username,
        message: message.trim(),
        timestamp: getCurrentTimestamp(),
        photoURL,
        type: "chat",
      };

      room.messages.push(msgObj);
      console.log(
        `💾 Message stored. Total messages in room: ${room.messages.length}`
      );

      emitToRoom(roomId, "chat-message", msgObj);
      console.log(`📤 Message broadcasted to room ${roomId}`);
    } catch (err) {
      console.error("❌ Error in chat-message handler:", err);
    }
  });

  socket.on("typing", (payload) => {
    try {
      const { roomId, username } = payload || {};
      if (!state.rooms[roomId]) return;
      socket.to(roomId).emit("user-typing", username);
    } catch (err) {
      console.error("❌ Error in typing handler:", err);
    }
  });

  socket.on("stop-typing", (payload) => {
    try {
      const { roomId, username } = payload || {};
      if (!state.rooms[roomId]) return;
      socket.to(roomId).emit("user-stopped-typing", username);
    } catch (err) {
      console.error("❌ Error in stop-typing handler:", err);
    }
  });

  socket.on("disconnecting", async () => {
    try {
      const { roomId, username } = socket;
      const room = state.rooms[roomId];

      if (roomId && username && room) {
        // Remove user from room
        room.users = room.users.filter((u) => u.username !== username);
        emitToRoom(roomId, "users-update", room.users);

        // Send leave message
        const leaveMessage = createSystemMessage(
          `${username} left the room.`,
          "user-action"
        );
        room.messages.push(leaveMessage);
        emitToRoom(roomId, "chat-message", leaveMessage);

        console.log(`👋 User ${username} left room ${roomId}`);

        // Schedule cleanup if room is empty
        if (room.users.length === 0) {
          scheduleRoomCleanup(roomId);
        }
      }
    } catch (err) {
      console.error("❌ Error during disconnecting:", err);
    }
  });
});

// ----------------------
// Graceful Shutdown
// ----------------------
async function gracefulShutdown() {
  try {
    console.log("🛑 Shutting down server...");

    // Cancel all cleanup timers
    Object.keys(state.cleanupTimers || {}).forEach((roomId) => {
      try {
        clearTimeout(state.cleanupTimers[roomId]);
      } catch {}
    });

    // Stop all monitors
    Object.keys(state.monitorIntervals || {}).forEach((roomId) => {
      try {
        stopContainerMonitor(roomId);
      } catch {}
    });

    // Close watchers and cleanup containers
    const cleanupPromises = Object.keys(state.rooms).map(async (roomId) => {
      try {
        await cleanupRoom(roomId);
      } catch (e) {
        console.error("Error cleaning room during shutdown:", roomId, e);
      }
    });

    await Promise.all(cleanupPromises);

    console.log("✅ Cleanup completed");
    process.exit(0);
  } catch (err) {
    console.error("❌ Error during graceful shutdown:", err);
    process.exit(1);
  }
}

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

// ----------------------
// Server Startup
// ----------------------
async function startServer() {
  try {
    await initializeWorkspace();

    server.listen(PORT, "0.0.0.0", () => {
      console.log("==================================================");
      console.log("🚀 COLLABORATIVE CODE SERVER STARTED");
      console.log("==================================================");
      console.log(`🌐 Server running on: http://localhost:${PORT}`);
      console.log(`📁 Workspace path: ${WORKSPACE_BASE_PATH}`);
      console.log(`🕐 Started at: ${getCurrentTimestamp()}`);
      console.log(`🔧 Base URL: ${BASE_URL}`);
      console.log("==================================================");
    });
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
}

startServer();
