// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { claimPrivileged } from "./native/privileged";
import { initExtensionHost } from "./extensions/host";
import { installKeyDiag } from "./dev/key-diag";
import { installErrorLog, syncNativeCrashes } from "./diagnostics/error-log";
import { windowRole } from "./diagnostics/environment";
import "./index.css";

// Record warnings, errors and crashes for Report an issue from the start, so
// boot failures are in it too. Kept on this computer; see error-log.ts.
installErrorLog({ source: windowRole() });

// TEMPORARY: watch for the intermittent "inputs/dropdowns stop accepting keys
// after toggling extensions" bug. No-op unless Developer Tools is enabled. Must
// run before any window key listener is registered so it can track them all.
installKeyDiag();

// Capture the privileged native bridge (raw fs + update installer) for core
// before any extension can load — see src/native/privileged.ts. Must precede
// initExtensionHost(), which activates built-ins and external plugins.
claimPrivileged();

// A GPU or renderer crash reloads the window; the main process remembers it.
void syncNativeCrashes();

// Built-ins register and external plugins begin loading before first paint,
// so sidebars/View menu populate without a flash of empty UI.
initExtensionHost();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
