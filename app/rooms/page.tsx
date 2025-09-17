"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import Head from "next/head";
import { getAuth, onAuthStateChanged, User, signOut } from "firebase/auth";
import { initializeApp, getApps, getApp } from "firebase/app";
import { v4 as uuidv4 } from "uuid";
import "./rooms.css";

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

// API Configuration
const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "https://8xqqzs-3001.csb.app";

// Helper for fetch with timeout
const fetchWithTimeout = async (
  url: string,
  options: RequestInit = {},
  timeout = 10000
) => {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(id);
  }
};

export default function JoinRoomPage() {
  const [roomCode, setRoomCode] = useState("");
  const [activeFeature, setActiveFeature] = useState("Code");
  const [user, setUser] = useState<User | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [isCreatingRoom, setIsCreatingRoom] = useState(false);
  const [error, setError] = useState("");
  const [isJoiningRoom, setIsJoiningRoom] = useState(false);
  const [serverStatus, setServerStatus] = useState<
    "checking" | "online" | "offline"
  >("checking");

  const roomCodeRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  // --- Firebase Auth ---
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      if (currentUser) setUser(currentUser);
      else router.push("/login");
    });
    return () => unsubscribe();
  }, [router]);

  // Test server connection on mount
  useEffect(() => {
    const testConnection = async () => {
      try {
        setServerStatus("checking");
        const response = await fetchWithTimeout(
          `${API_BASE_URL}/health`,
          {},
          10000
        );

        if (response.ok) {
          const data = await response.json().catch(() => ({}));
          console.log("Server connection test successful:", data);
          setServerStatus("online");
        } else {
          console.warn("Server responded with error status:", response.status);
          setServerStatus("offline");
          setError(
            `Server health check failed with status: ${response.status}`
          );
        }
      } catch (err: any) {
        console.error("Server connection test failed:", err);
        setServerStatus("offline");
        if (err.name === "AbortError") {
          setError(
            "Server connection timeout. Please check if the backend is running."
          );
        } else {
          setError(
            "Cannot connect to server. Please make sure the backend is running."
          );
        }
      }
    };
    testConnection();
  }, []);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = () => menuOpen && setMenuOpen(false);
    if (menuOpen) document.addEventListener("click", handleClickOutside);
    return () => document.removeEventListener("click", handleClickOutside);
  }, [menuOpen]);

  const validateRoomCode = (code: string) => {
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(code.trim());
  };

  const handleCreateRoom = async () => {
    if (!user) return setError("You must be logged in to create a room.");
    if (serverStatus !== "online")
      return setError("Cannot create room: server is not available.");

    setIsCreatingRoom(true);
    setError("");

    try {
      const newRoomId = uuidv4();
      console.log("Creating room with ID:", newRoomId);

      const response = await fetchWithTimeout(
        `${API_BASE_URL}/create-room`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ roomId: newRoomId }),
        },
        15000
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          errorData.error || `Server responded with status ${response.status}`
        );
      }

      const data = await response.json();
      console.log("Room created successfully:", data);

      if (data.success) router.push(`/editor?room=${newRoomId}`);
      else throw new Error(data.error || "Failed to create room");
    } catch (err: any) {
      console.error("Error creating room:", err);
      if (err.name === "AbortError")
        setError("Room creation timeout. Please try again.");
      else if (err.name === "TypeError" && err.message === "Failed to fetch") {
        setError(
          "Cannot connect to server. Please check your internet connection."
        );
        setServerStatus("offline");
      } else setError(`Failed to create room: ${err.message}`);
    } finally {
      setIsCreatingRoom(false);
    }
  };

  const handleJoinRoom = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const trimmedRoomCode = roomCode.trim();

    if (!trimmedRoomCode) return setError("Please enter a room code.");
    if (!validateRoomCode(trimmedRoomCode))
      return setError("Please enter a valid room code format.");
    if (!user) return setError("You must be logged in to join a room.");
    if (serverStatus !== "online")
      return setError("Cannot join room: server is not available.");

    setIsJoiningRoom(true);
    setError("");

    try {
      const response = await fetchWithTimeout(
        `${API_BASE_URL}/project/${trimmedRoomCode}/vscode`,
        { method: "GET", headers: { "Content-Type": "application/json" } },
        10000
      );

      if (!response.ok) {
        if (response.status === 404)
          setError("Room not found. Please check the room code.");
        else if (response.status >= 500)
          setError("Server error. Please try again later.");
        else {
          const errorData = await response.json().catch(() => ({}));
          setError(errorData.error || "Failed to join room. Please try again.");
        }
        return;
      }

      const data = await response.json();
      console.log("Room found:", data);
      router.push(`/editor?room=${trimmedRoomCode}`);
    } catch (err: any) {
      console.error("Error joining room:", err);
      if (err.name === "AbortError")
        setError("Join room timeout. Please try again.");
      else if (err.name === "TypeError" && err.message === "Failed to fetch") {
        setError(
          "Cannot connect to server. Please check your internet connection."
        );
        setServerStatus("offline");
      } else
        setError(
          "Failed to join room. Please check the room code and try again."
        );
    } finally {
      setIsJoiningRoom(false);
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
      setMenuOpen(false);
      router.push("/login");
    } catch (err) {
      console.error("Error signing out:", err);
      setError("Failed to logout. Please try again.");
    }
  };

  const getServerStatusText = () => {
    switch (serverStatus) {
      case "checking":
        return "Checking server...";
      case "online":
        return "Server online";
      case "offline":
        return "Server offline";
      default:
        return "";
    }
  };

  return (
    <div
      className={`rooms-container ${
        isCreatingRoom || isJoiningRoom ? "rooms-loading" : ""
      }`}
    >
      <Head>
        <title>Join Room - ChatNix</title>
        <meta
          name="description"
          content="Join or create collaborative development rooms on ChatNix"
        />
      </Head>

      {/* HEADER */}
      <header className="rooms-header">
        <h1 className="rooms-logo">
          CHAT<span className="rooms-green">N</span>IX
        </h1>
        {user && (
          <div className="rooms-user-info">
            <div
              className="rooms-profile-menu"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen(!menuOpen);
              }}
            >
              <img
                src={user.photoURL || "/default-avatar.webp"}
                alt="User Avatar"
                className="rooms-avatar"
                onError={(e) => {
                  (e.target as HTMLImageElement).src = "/default-avatar.webp";
                }}
              />
              <span className="rooms-username">
                {user.displayName || user.email || "User"}
              </span>
              {menuOpen && (
                <>
                  <div className="rooms-dropdown-backdrop" />
                  <div className="rooms-dropdown">
                    <button onClick={handleLogout} type="button">
                      Logout
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </header>

      {/* JOIN / CREATE ROOM */}
      <div className="rooms-box">
        <div className="rooms-hero-section">
          <h1 className="rooms-hero-title">
            Your collaborative development workspace
          </h1>
          <p className="rooms-hero-description">
            Connect with developers, share code in real-time, and build amazing
            projects together. ChatNix brings your team's workflow to one
            unified platform.
          </p>
          <div className="rooms-features">
            {["Code", "Chat", "Merge", "Meet"].map((feature) => (
              <button
                key={feature}
                className={`rooms-feature-btn ${
                  activeFeature === feature ? "active" : ""
                }`}
                onClick={() => setActiveFeature(feature)}
                type="button"
              >
                <span className="rooms-arrow">→</span> {feature}
              </button>
            ))}
          </div>
        </div>

        <div className="rooms-divider"></div>

        <div className="rooms-join-section">
          <button
            className="rooms-create-btn"
            onClick={handleCreateRoom}
            disabled={isCreatingRoom || !user || serverStatus !== "online"}
            type="button"
          >
            {isCreatingRoom ? "Creating Room..." : "Create a Room"}
          </button>

          <form onSubmit={handleJoinRoom} className="rooms-join-form">
            <div className="rooms-input-group">
              <input
                ref={roomCodeRef}
                type="text"
                placeholder="Enter The Room Code"
                value={roomCode}
                onChange={(e) => setRoomCode(e.target.value)}
                disabled={isJoiningRoom || serverStatus !== "online"}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <button
              type="submit"
              className="rooms-join-btn"
              disabled={
                isJoiningRoom ||
                !user ||
                !roomCode.trim() ||
                serverStatus !== "online"
              }
            >
              {isJoiningRoom ? "Joining Room..." : "Join a Room"}
            </button>
          </form>

          {serverStatus !== "online" && (
            <div className="rooms-warning-message">{getServerStatusText()}</div>
          )}
          {error && <div className="rooms-error-message">{error}</div>}
          {!user && (
            <div className="rooms-warning-message">
              Please log in to create or join rooms.
            </div>
          )}
        </div>

        <div className="rooms-signup-link">
          New to ChatNix? <a href="/signup">Create an account</a>
        </div>
      </div>
    </div>
  );
}
