import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// Suppresses the webview's native "Back/Forward/Reload/Inspect Element"
// context menu app-wide, so right-click reads as "does nothing yet" rather
// than a leaked browser chrome — Session has no custom context menus of its
// own to show in its place yet.
document.addEventListener("contextmenu", (e) => e.preventDefault());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
