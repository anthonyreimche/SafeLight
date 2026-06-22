// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { claimPrivileged } from "./native/privileged";
import { initExtensionHost } from "./extensions/host";
import "./index.css";

// Capture the privileged native bridge (raw fs + update installer) for core
// before any extension can load — see src/native/privileged.ts. Must precede
// initExtensionHost(), which activates built-ins and external plugins.
claimPrivileged();

// Built-ins register and external plugins begin loading before first paint,
// so sidebars/View menu populate without a flash of empty UI.
initExtensionHost();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
