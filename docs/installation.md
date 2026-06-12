# Installation

Safelight 1.0 ships two ways: a packaged **Windows desktop app** (recommended) and a **browser app** run from source. The desktop app guarantees the fast RAW decode path and full GPU acceleration; the browser version is handy for development.

## Windows Desktop App

Download and run the latest `Safelight Setup <version>.exe` from the releases page. The installer (NSIS) lets you pick the install directory and creates desktop / Start-menu shortcuts.

### Building the installer yourself

Prerequisites: Node.js 18+ and npm.

```bash
npm install
npm run build:electron
```

Output lands in `release/` (`Safelight Setup <version>.exe` plus an unpacked build). On Windows you can instead double-click **`build-electron.bat`**, which also generates the icon and signs the build with a local self-signed certificate (run as Administrator for machine-wide trust; see `make-cert.ps1`).

Why a desktop app? RAW decoding runs libraw-wasm on shared memory in a worker, which requires a cross-origin-isolated secure context. The Electron shell serves the app over a privileged `app://` scheme with COOP/COEP headers and pins Chromium to the fast GPU path (discrete GPU, D3D11 ANGLE, no software fallback).

## Running from Source (browser)

1. **Clone and install**:

   ```bash
   git clone https://github.com/anthonyreimche/SafeLight.git
   cd SafeLight
   npm install
   ```

2. **Start the dev server**:

   ```bash
   npm run dev
   ```

   Vite serves at `http://localhost:5173` (or the next free port). On Windows you can double-click **`start.bat`**, which installs dependencies on first run and starts the server.

3. **Desktop window in dev**: `npm run electron:dev` builds the renderer and opens it in Electron.

### Production web build

```bash
npm run build    # tsc + vite build → dist/
npm run preview  # serve the production build locally
```

## Requirements

- **Node.js** 18 or newer (for source builds)
- **GPU with WebGL2** — all image processing is GPU-accelerated
- **Browser** (web version): a recent Chromium-based browser (Chrome, Edge, Opera). Safelight depends on the File System Access API for project folders; Firefox and Safari are not supported for full functionality.

## Troubleshooting

**"WebGL2 not supported"** — update your graphics drivers and make sure hardware acceleration is enabled. The desktop app forces the high-performance GPU automatically.

**RAW files look soft or load as small previews (browser)** — full-speed RAW decoding needs cross-origin isolation, which the plain dev server does not provide in all configurations. Use the desktop app for guaranteed full-resolution RAW.

**Photos missing after restart (browser)** — folder permissions expire between browser sessions. Click **Reconnect** in the top bar to re-grant access; the desktop app is not affected the same way once permission is granted.

**Port already in use** — Vite automatically tries the next port (5174, 5175, …).
