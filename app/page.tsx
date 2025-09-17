"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import "./home.css";

export default function Home() {
  const router = useRouter();

  const goToLogin = () => {
    router.push("/login");
  };

  const goToSignup = () => {
    router.push("/signup");
  };

  return (
    <main className="main">
      <div>
        <span className="logoSymbol">{"{}"}</span>
      </div>

      <div className="container">
        {/* Logo and Welcome Text */}
        <div className="logoSection">
          <div className="logo"></div>
          <h1 className="welcomeText">
            Welcome to CHAT<strong className="green">N</strong>IX
          </h1>
        </div>

        {/* Description */}
        <p className="description">Your collaborative development workspace</p>
        <p className="subDescription">
          Connect with developers, share code in real-time, and build amazing
          projects together. DevCollab brings your team's workflow to one
          unified platform.
        </p>

        {/* Feature Buttons */}
        <div className="featureButtons">
          <button className="featureBtn">
            <strong className="green">→</strong> Code
          </button>
          <button className="featureBtn">
            <strong className="green">→</strong> Chat
          </button>
          <button className="featureBtn">
            <strong className="green">→</strong> Merge
          </button>
          <button className="featureBtn">
            <strong className="green">→</strong> Meet
          </button>
        </div>

        {/* Sign In Button */}
        <button onClick={goToLogin} className="signInBtn">
          Sign In To Get Started
        </button>

        {/* Loading Indicator */}
        <div className="loadingSection">
          <span className="loadingIcon">$</span> Loading
          <div className="progressBar"></div>
        </div>

        {/* New to DevCollab? */}
        <p className="footerText">
          New to DevCollab?{" "}
          <span onClick={goToSignup} className="createAccountLink">
            Create an account
          </span>
        </p>
      </div>
    </main>
  );
}
