import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import "./styles.css";

if ("__TAURI_INTERNALS__" in window) {
  const mainWindow = getCurrentWindow();
  void mainWindow.onCloseRequested((event) => {
    event.preventDefault();
    void mainWindow.hide();
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
