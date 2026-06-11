import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initExtensionHost } from "./extensions/host";
import "./index.css";

// Built-ins register and external plugins begin loading before first paint,
// so sidebars/View menu populate without a flash of empty UI.
initExtensionHost();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
