import React from "react";
import { createRoot } from "react-dom/client";
import { RootApp } from "./RootApp.jsx";
import "./index.css";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <RootApp />
  </React.StrictMode>,
);
