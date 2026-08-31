"use client";

import React, { useState, useRef, useEffect } from "react";
import { initializeApp, getApps, getApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  GithubAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  updateProfile,
} from "firebase/auth";
// @ts-ignore
import "./signup.css"; // Import the CSS file first

// --- Firebase Configuration ---
const firebaseConfig = {
  apiKey: "AIzaSyAczWcIvmkAacGi4p5D75M9lc5J0e2pneg",
  authDomain: "chatnix-5ef49.firebaseapp.com",
  projectId: "chatnix-5ef49",
  storageBucket: "chatnix-5ef49.appspot.com",
  messagingSenderId: "894625701808",
  appId: "1:894625701808:web:06f4800a2cac91b92ec075",
};

// --- Initialize Firebase ---
const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();
const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });
const githubProvider = new GithubAuthProvider();

export default function SignupPage() {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [currentFocus, setCurrentFocus] = useState("fullName");
  const [isAnimating, setIsAnimating] = useState(false);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmPasswordRef = useRef<HTMLInputElement>(null);

  const validateForm = () => {
    if (!fullName.trim()) {
      setError("Full name is required.");
      return false;
    }
    if (!email.trim()) {
      setError("Email is required.");
      return false;
    }
    if (!password.trim()) {
      setError("Password is required.");
      return false;
    }
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return false;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return false;
    }
    return true;
  };

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setIsLoading(true);

    if (!validateForm()) {
      setIsLoading(false);
      return;
    }

    try {
      const userCredential = await createUserWithEmailAndPassword(
        auth,
        email.trim(),
        password
      );

      await updateProfile(userCredential.user, {
        displayName: fullName.trim(),
      });

      // onAuthStateChanged will handle the redirect
    } catch (err: any) {
      setError(err.message.replace("Firebase: ", ""));
      setIsLoading(false);
    }
  };

  const handleProviderSignup = async (provider: any) => {
    setError("");
    setIsLoading(true);

    try {
      await signInWithPopup(auth, provider);
    } catch (err: any) {
      if (
        err?.code === "auth/popup-blocked" ||
        err?.code === "auth/cancelled-popup-request"
      ) {
        try {
          await signInWithRedirect(auth, provider);
        } catch (redirectErr) {
          setError("Sign-up failed. Please try again.");
          setIsLoading(false);
        }
      } else {
        setError("Sign-up failed. Please try again.");
        setIsLoading(false);
      }
    }
  };

  useEffect(() => {
    getRedirectResult(auth)
      .then((res) => {
        if (res?.user) {
          const username = res.user.displayName || res.user.email || "User";
          localStorage.setItem("username", username);
          window.location.replace("/rooms");
        }
      })
      .catch(() => setError("Failed to complete sign-up. Please try again."));
  }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => {
      if (user) {
        const username = user.displayName || user.email || "User";
        localStorage.setItem("username", username);
        window.location.replace("/rooms");
      }
    });
    return () => unsub();
  }, []);

  const handleInputKeyDown = (e: React.KeyboardEvent, nextField: string) => {
    if (e.key === "Enter") {
      e.preventDefault();

      // Get current field value to check if it's filled
      const currentValue = getCurrentFieldValue();
      if (!currentValue.trim()) return; // Don't advance if current field is empty

      setIsAnimating(true);
      setCurrentFocus("");

      setTimeout(() => {
        setCurrentFocus(nextField);
        setIsAnimating(false);

        // Focus the next input
        switch (nextField) {
          case "email":
            emailRef.current?.focus();
            break;
          case "password":
            passwordRef.current?.focus();
            break;
          case "confirmPassword":
            confirmPasswordRef.current?.focus();
            break;
          default:
            break;
        }
      }, 300);
    }
  };

  const getCurrentFieldValue = () => {
    switch (currentFocus) {
      case "fullName":
        return fullName;
      case "email":
        return email;
      case "password":
        return password;
      case "confirmPassword":
        return confirmPassword;
      default:
        return "";
    }
  };

  const handleInputFocus = (fieldName: string) => {
    if (!isAnimating) {
      setCurrentFocus(fieldName);
    }
  };

  const handleInputBlur = (fieldName: string, value: string) => {
    if (value === "" && !isAnimating) {
      setCurrentFocus("fullName");
    }
  };

  const getPasswordStrength = (password: string) => {
    if (password.length < 6) return "weak";
    if (password.length < 10) return "medium";
    return "strong";
  };

  return (
    <main className={`signup-main ${isLoading ? "signup-loading" : ""}`}>
      <div className="signup-box">
        <h1 className="signup-logo">
          CHAT<span className="signup-green">N</span>IX
        </h1>

        <form onSubmit={handleSignup} className="signup-form">
          {/* Full Name */}
          <div className="input-group">
            <span
              className={`signup-braces ${
                currentFocus === "fullName" ? "fade-in" : "fade-out"
              }`}
            >
              {"{"}
            </span>
            <input
              type="text"
              placeholder="FULL NAME"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              onKeyDown={(e) => handleInputKeyDown(e, "email")}
              onFocus={() => handleInputFocus("fullName")}
              onBlur={() => handleInputBlur("fullName", fullName)}
              disabled={isLoading}
              autoFocus
              autoComplete="name"
              required
            />
            <span
              className={`signup-braces ${
                currentFocus === "fullName" ? "fade-in" : "fade-out"
              }`}
            >
              {"}"}
            </span>
          </div>

          {/* Email */}
          <div className="input-group">
            <span
              className={`signup-braces ${
                currentFocus === "email" ? "fade-in" : "fade-out"
              }`}
            >
              {"{"}
            </span>
            <input
              ref={emailRef}
              type="email"
              placeholder="EMAIL"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => handleInputKeyDown(e, "password")}
              onFocus={() => handleInputFocus("email")}
              onBlur={() => handleInputBlur("email", email)}
              disabled={isLoading}
              autoComplete="email"
              required
            />
            <span
              className={`signup-braces ${
                currentFocus === "email" ? "fade-in" : "fade-out"
              }`}
            >
              {"}"}
            </span>
          </div>

          {/* Password */}
          <div className="input-group">
            <span
              className={`signup-braces ${
                currentFocus === "password" ? "fade-in" : "fade-out"
              }`}
            >
              {"{"}
            </span>
            <input
              ref={passwordRef}
              type="password"
              placeholder="PASSWORD"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => handleInputKeyDown(e, "confirmPassword")}
              onFocus={() => handleInputFocus("password")}
              onBlur={() => handleInputBlur("password", password)}
              disabled={isLoading}
              autoComplete="new-password"
              required
              minLength={6}
            />
            <span
              className={`signup-braces ${
                currentFocus === "password" ? "fade-in" : "fade-out"
              }`}
            >
              {"}"}
            </span>
          </div>

          {/* Password Strength Indicator */}
          {password && (
            <div
              className={`password-strength ${getPasswordStrength(password)}`}
            >
              {getPasswordStrength(password)} password
            </div>
          )}

          {/* Confirm Password */}
          <div className="input-group">
            <span
              className={`signup-braces ${
                currentFocus === "confirmPassword" ? "fade-in" : "fade-out"
              }`}
            >
              {"{"}
            </span>
            <input
              ref={confirmPasswordRef}
              type="password"
              placeholder="CONFIRM PASSWORD"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              onFocus={() => handleInputFocus("confirmPassword")}
              onBlur={() => handleInputBlur("confirmPassword", confirmPassword)}
              disabled={isLoading}
              autoComplete="new-password"
              required
            />
            <span
              className={`signup-braces ${
                currentFocus === "confirmPassword" ? "fade-in" : "fade-out"
              }`}
            >
              {"}"}
            </span>
          </div>

          {/* Error Message */}
          {error && <p className="signup-error-message">{error}</p>}

          {/* Signup Button */}
          <button
            type="submit"
            className={`signup-btn ${isLoading ? "loading" : ""}`}
            disabled={isLoading}
          >
            {isLoading ? "CREATING ACCOUNT..." : "SIGN UP"}
          </button>

          {/* Social Login */}
          <div className="signup-social-login">
            <p>or continue with</p>
            <div className="signup-social-icons">
              <button
                type="button"
                onClick={() => handleProviderSignup(googleProvider)}
                className="signup-social-btn"
                disabled={isLoading}
                aria-label="Sign up with Google"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 48 48"
                  width="32px"
                  height="32px"
                >
                  <path
                    fill="#FFC107"
                    d="M43.611,20.083H42V20H24v8h11.303c-1.649,4.657-6.08,8-11.303,8c-6.627,0-12-5.373-12-12s5.373-12,12-12c3.059,0,5.842,1.154,7.961,3.039l5.657-5.657C34.046,6.053,29.268,4,24,4C12.955,4,4,12.955,4,24s8.955,20,20,20s20-8.955,20-20C44,22.659,43.862,21.35,43.611,20.083z"
                  />
                  <path
                    fill="#FF3D00"
                    d="M6.306,14.691l6.571,4.819C14.655,15.108,18.961,12,24,12c3.059,0,5.842,1.154,7.961,3.039l5.657-5.657C34.046,6.053,29.268,4,24,4C16.318,4,9.656,8.337,6.306,14.691z"
                  />
                  <path
                    fill="#4CAF50"
                    d="M24,44c5.166,0,9.86-1.977,13.409-5.192l-6.19-5.238C29.211,35.091,26.715,36,24,36c-5.223,0-9.641-3.657-11.28-8.591l-6.522,5.025C9.505,39.556,16.227,44,24,44z"
                  />
                  <path
                    fill="#1976D2"
                    d="M43.611,20.083H42V20H24v8h11.303c-0.792,2.237-2.231,4.166-4.087,5.571l6.19,5.238C42.021,35.591,44,30.021,44,24C44,22.659,43.862,21.35,43.611,20.083z"
                  />
                </svg>
              </button>

              <button
                type="button"
                onClick={() => handleProviderSignup(githubProvider)}
                className="signup-social-btn"
                disabled={isLoading}
                aria-label="Sign up with GitHub"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 32 32"
                  width="32px"
                  height="32px"
                  fill="white"
                >
                  <path d="M16 0.395c-8.836 0-16 7.163-16 16 0 7.068 4.582 13.067 10.938 15.187 0.8 0.147 1.092-0.347 1.092-0.77 0-0.38-0.015-1.642-0.023-3.22-4.448 0.967-5.388-1.922-5.388-1.922-0.727-1.848-1.775-2.34-1.775-2.34-1.452-0.993 0.11-0.973 0.11-0.973 1.605 0.113 2.45 1.648 2.45 1.648 1.427 2.443 3.743 1.737 4.656 1.328 0.145-1.033 0.558-1.737 1.016-2.135-3.554-0.404-7.29-1.777-7.29-7.907 0-1.747 0.625-3.177 1.648-4.298-0.165-0.404-0.714-2.033 0.156-4.237 0 0 1.343-0.43 4.4 1.64 1.276-0.355 2.645-0.533 4.006-0.539 1.361 0.006 2.73 0.184 4.006 0.539 3.055-2.07 4.396-1.64 4.396-1.64 0.872 2.204 0.323 3.833 0.158 4.237 1.025 1.12 1.648 2.55 1.648 4.298 0 6.145-3.74 7.498-7.305 7.898 0.574 0.493 1.088 1.472 1.088 2.967 0 2.14-0.02 3.865-0.02 4.39 0 0.426 0.288 0.925 1.098 0.768 6.354-2.123 10.93-8.12 10.93-15.185 0-8.837-7.164-16-16-16z" />
                </svg>
              </button>
            </div>
          </div>

          {/* Login Link */}
          <div className="signup-login-link">
            Already have an account? <a href="/login">Login</a>
          </div>
        </form>
      </div>
    </main>
  );
}
