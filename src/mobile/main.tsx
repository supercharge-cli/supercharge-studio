import React from "react";
import ReactDOM from "react-dom/client";
import MobileApp from "./MobileApp";
import "../styles.css";
import "./mobile.css";

// The page is an app shell. A two-finger pinch must not zoom it.
document.addEventListener("touchmove", (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
document.addEventListener("gesturestart", (e) => e.preventDefault());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MobileApp />
  </React.StrictMode>,
);
