"use client";

import { Suspense, useEffect, useState, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { io, Socket } from "socket.io-client";
import { getAuth, onAuthStateChanged, signOut, User } from "firebase/auth";
import { initializeApp, getApps, getApp } from "firebase/app";
//@ts-ignore
import "./editor.css";

// --- Firebase Config ---
const firebaseConfig = {
  apiKey: "AIzaSyAczWcIvmkAacGi4p5D75M9lc5J0e2pneg",
  authDomain: "chatnix-5ef49.firebaseapp.com",
  projectId: "chatnix-5ef49",
  storageBucket: "chatnix-5ef49.appspot.com",
  messagingSenderId: "894625701808",
  appId: "1:894625701808:web:06f4800a2cac91b92ec075",
};

const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();
const auth = getAuth(app);

// Types
interface Message {
  id?: string;
  username: string;
  message: string;
  timestamp: string;
  photoURL?: string;
  type?: "chat" | "system" | "user-action" | "file-change";
}

interface UserData {
  username: string;
  photoURL?: string;
  joinedAt?: string;
}

// Component that uses useSearchParams
function EditorContent() {
  const searchParams = useSearchParams();
  const roomId = searchParams.get("room") || "default-room";

  const [user, setUser] = useState<User | null>(null);
  const [socketServerUrl, setSocketServerUrl] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [users, setUsers] = useState<UserData[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  const [connectionStatus, setConnectionStatus] =
    useState<string>("connecting");

  const [vsCodeUrl, setVsCodeUrl] = useState<string | null>(null);
  const [iframeKey, setIframeKey] = useState(0);
  const [iframeLoading, setIframeLoading] = useState(true);
  const [isChatOpen, setIsChatOpen] = useState(true);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const typingTimeoutRef = useRef<number | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const heartbeatRef = useRef<number | null>(null);
  const silentReconnectRef = useRef<boolean>(true);

  // --- Client-only socket URL ---
  useEffect(() => {
    setSocketServerUrl(
      `${window.location.protocol === "https:" ? "wss" : "ws"}://localhost:3001`
    );
  }, []);

  // Scroll messages to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Firebase Auth
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      if (!currentUser) window.location.href = "/login";
      else setUser(currentUser);
    });
    return () => unsubscribe();
  }, []);

  // Socket.IO connection
  useEffect(() => {
    if (!user || !socketServerUrl || socketRef.current) return;

    const socket = io(socketServerUrl, {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 20000,
    });

    socketRef.current = socket;

    const safeEmit = (event: string, payload?: unknown) => {
      try {
        socket.emit(event, payload);
      } catch (err) {
        console.error(`Emit failed (${event}):`, err);
      }
    };

    // Connection handlers
    socket.on("connect", () => {
      setConnectionStatus("connected");
      silentReconnectRef.current = true;

      safeEmit("join-room", {
        roomId,
        username: user.displayName || user.email,
        photoURL: user.photoURL || "",
      });
    });

    socket.on("disconnect", () => {
      setConnectionStatus(
        silentReconnectRef.current ? "connected" : "disconnected"
      );
    });

    socket.on("reconnect", () => {
      setConnectionStatus("connected");
      silentReconnectRef.current = true;
    });

    // Chat & room events
    socket.on("chat-message", (msg: Message) =>
      setMessages((prev) => [...prev, msg])
    );
    socket.on("chat-history", (history: Message[]) =>
      Array.isArray(history) && setMessages(history)
    );
    socket.on("users-update", (roomUsers: UserData[]) =>
      Array.isArray(roomUsers) && setUsers(roomUsers)
    );
    socket.on("user-typing", (username: string) =>
      setTypingUsers((prev) => Array.from(new Set([...prev, username])))
    );
    socket.on("user-stopped-typing", (username: string) =>
      setTypingUsers((prev) => prev.filter((u) => u !== username))
    );

    // VS Code iframe
    socket.on("vscode-url", (url: string | null) => {
      setVsCodeUrl((prev) => {
        if (url && prev !== url) setIframeKey((k) => k + 1);
        setIframeLoading(!!url);
        return url;
      });
    });

    // Room reset
    socket.on("room-reset", () => {
      setIframeKey((k) => k + 1);
      setIframeLoading(true);
    });

    // Heartbeat
    heartbeatRef.current = window.setInterval(() => {
      if (socketRef.current?.connected) socketRef.current.emit("ping");
    }, 25000);

    return () => {
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = null;
      }
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [roomId, user, socketServerUrl]);

  // Chat input handlers
  const sendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim() || !user || connectionStatus !== "connected") return;

    const username = user.displayName || user.email!;
    const photoURL = user.photoURL || "";

    socketRef.current?.emit("chat-message", {
      roomId,
      username,
      message: chatInput.trim(),
      photoURL,
    });
    socketRef.current?.emit("stop-typing", { roomId, username });
    setChatInput("");
  };

  const handleTyping = (e: React.ChangeEvent<HTMLInputElement>) => {
    setChatInput(e.target.value);
    if (!user) return;

    const username = user.displayName || user.email!;
    socketRef.current?.emit("typing", { roomId, username });

    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = window.setTimeout(() => {
      socketRef.current?.emit("stop-typing", { roomId, username });
      typingTimeoutRef.current = null;
    }, 1500);
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
    } catch (err) {
      console.error(err);
    } finally {
      socketRef.current?.disconnect();
      window.location.href = "/login";
    }
  };

  const handleLeaveRoom = () => {
    const username = user?.displayName || user?.email!;
    if (username) socketRef.current?.emit("stop-typing", { roomId, username });
    socketRef.current?.disconnect();
    window.location.href = "/";
  };

  return (
    <div className="editor-container">
      {/* HEADER */}
      <div className="editor-header">
        <div className="status-info">
          <span>Room: {roomId}</span>
          <span>
            Status:{" "}
            <span
              className={
                connectionStatus === "connected"
                  ? "status-connected"
                  : "status-disconnected"
              }
            >
              {connectionStatus}
            </span>
          </span>
        </div>

        <div className="users-avatars">
          {users.map((u, idx) => (
            <img
              key={idx}
              src={u.photoURL || "/default-avatar.webp"}
              alt={u.username}
              className="user-avatar"
            />
          ))}
        </div>

        {user && (
          <div className="user-menu">
            <div
              onClick={() => setMenuOpen(!menuOpen)}
              className="user-menu-trigger"
            >
              <img
                src={user.photoURL || "/default-avatar.webp"}
                alt="avatar"
                className="user-menu-avatar"
              />
              <span>{user.displayName || user.email}</span>
            </div>
            {menuOpen && (
              <div className="user-menu-dropdown">
                <button
                  onClick={handleLeaveRoom}
                  className="menu-button leave-button"
                >
                  Leave Room
                </button>
                <button
                  onClick={handleLogout}
                  className="menu-button logout-button"
                >
                  Logout
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* MAIN CONTENT */}
      <div className="main-content">
        {/* LEFT: VS Code iframe */}
        <div className="editor-section">
          {iframeLoading && vsCodeUrl && (
            <div className="loading-overlay">
              <div className="spinner" /> Loading VS Code...
            </div>
          )}

          {vsCodeUrl ? (
            <iframe
              key={iframeKey}
              src={`${vsCodeUrl.replace(/\/$/, "")}/?folder=/home/coder`}
              className="vscode-iframe"
              title="VS Code"
              onLoad={() => setIframeLoading(false)}
              onError={() => setIframeLoading(false)}
            />
          ) : (
            <div className="no-vscode">
              VS Code is not available for this room.
            </div>
          )}
        </div>

        {/* RIGHT: Chat */}
        {isChatOpen ? (
          <div className="chat-section">
            <div className="chat-header">
              <span>Chat</span>
              <button
                onClick={() => setIsChatOpen(false)}
                className="close-chat-button"
                title="Close chat"
              >
                ×
              </button>
            </div>

            <div className="messages-container">
              {messages.map((msg, i) => (
                <div key={msg.id ?? i} className="message-item">
                  {msg.type === "user-action" ||
                  msg.type === "file-change" ||
                  msg.username === "system" ? (
                    <div className="system-message">{msg.message}</div>
                  ) : (
                    <div
                      className={`user-message ${
                        msg.username === (user?.displayName || user?.email)
                          ? "message-right"
                          : "message-left"
                      }`}
                    >
                      <img
                        src={msg.photoURL || "/default-avatar.webp"}
                        alt="avatar"
                        className="message-avatar"
                      />
                      <div className="message-content">
                        <strong>{msg.username}</strong>: {msg.message}
                        <br />
                        <small className="message-timestamp">
                          {new Date(msg.timestamp).toLocaleTimeString()}
                        </small>
                      </div>
                    </div>
                  )}
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>

            {typingUsers.length > 0 && (
              <div className="typing-indicator">
                {typingUsers.join(", ")}{" "}
                {typingUsers.length === 1 ? "is" : "are"} typing...
              </div>
            )}

            <form onSubmit={sendMessage} className="chat-form">
              <label htmlFor="chatInput" className="sr-only">
                Message
              </label>
              <input
                id="chatInput"
                name="chatInput"
                type="text"
                value={chatInput}
                onChange={handleTyping}
                placeholder="Type a message..."
                className="chat-input"
                autoComplete="off"
              />
              <button
                type="submit"
                disabled={connectionStatus !== "connected"}
                className={`send-button ${
                  connectionStatus === "connected"
                    ? "send-button-enabled"
                    : "send-button-disabled"
                }`}
              >
                Send
              </button>
            </form>
          </div>
        ) : (
          // Floating reopen button
          <button
            className="reopen-chat-button"
            onClick={() => setIsChatOpen(true)}
            title="Open chat"
          >
            💬
          </button>
        )}
      </div>
    </div>
  );
}

// Main page component with Suspense
export default function EditorPage() {
  return (
    <Suspense fallback={
      <div className="editor-container">
        <div className="editor-header">
          <h1 className="editor-logo">CHAT<span className="editor-green">N</span>IX</h1>
        </div>
        <div className="main-content">
          <div className="editor-section">
            <div className="loading-overlay">
              <div className="spinner" /> Loading editor...
            </div>
          </div>
        </div>
      </div>
    }>
      <EditorContent />
    </Suspense>
  );
}