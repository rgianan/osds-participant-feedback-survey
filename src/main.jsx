import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./style.css";
import "./analytics.css";
import "./auth.css";
import "./production.css";
import "./superadmin.css";
import "./verification.css";
import "./audit.css";
createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
