# Installation

Safelight 1.0 ships three ways: a packaged **Windows desktop app** (recommended), **Linux packages** for every major distro family, and a **browser app** run from source. The desktop app guarantees the fast RAW decode path and full GPU acceleration; the browser version is handy for development.

## Windows Desktop App

Download and run the latest `Safelight Setup <version>.exe` from the releases page. The installer (NSIS) lets you pick the install directory and creates desktop / Start-menu shortcuts.

## Linux Desktop App

Download the package for your distro from the releases page:

| Package | Distros | Install command |
|---|---|---|
| `safelight_<version>_amd64.deb` | Debian, Ubuntu, Mint | `sudo apt install ./safelight_<version>_amd64.deb` |
| `safelight-<version>.x86_64.rpm` | Fedora, openSUSE, RHEL | `sudo dnf install ./safelight-<version>.x86_64.rpm` |
| `safelight-<version>.pacman` | Arch, Manjaro, EndeavourOS | `sudo pacman -U safelight-<version>.pacman` |
| `Safelight-<version>.AppImage` | any distro, no install | `chmod +x` the file and run it |
| `safelight_<version>_amd64.flatpak` | any distro with Flatpak | `flatpak install ./safelight_<version>_amd64.flatpak` |

## Building the desktop apps yourself

All build scripts live in **`build-scripts/`** and are one-click `.bat` files.

### Windows installer

Prerequisites: Node.js 18+ and npm.

Double-click **`build-scripts\build-electron-windows-exe.bat`** (or run `npm run build:electron`). It installs dependencies, builds the web app, generates the icon, signs the build with a local self-signed certificate (`CN=Safelight` — run as Administrator for machine-wide trust; see `make-cert.ps1`), and leaves a single `Safelight Setup <version>.exe` in `release/`.

### Linux packages (from Windows)

Linux targets can't be built natively on Windows, so the scripts run electron-builder inside **WSL2**. Prerequisites: WSL2 with Node.js 20+ and `rsync` installed in the distro.

Double-click any of:

- `build-scripts\build-linux-deb.bat`
- `build-scripts\build-linux-rpm.bat`
- `build-scripts\build-linux-arch-pacman.bat`
- `build-scripts\build-linux-appimage.bat`
- `build-scripts\build-linux-flatpak.bat` (also needs `flatpak` + `flatpak-builder` in WSL; the script prints the one-time setup commands)

Sources are synced to a native ext4 directory inside WSL (`~/.cache/safelight-linux-build`) so the Linux `node_modules` never collides with the Windows one; the finished package is copied back to `release/linux/`.

### Linux packages (on Linux)

Run the shared script directly from the repo root: `bash build-scripts/linux-build.sh <deb|rpm|pacman|AppImage|flatpak>`.

### macOS installer

macOS packages can only be built **on a Mac** (electron-builder needs `hdiutil`/`codesign`; there is no WSL equivalent). On a Mac with Node 20+, run:

```bash
bash build-scripts/build-macos-dmg.sh
```

Output: `release/Safelight-<version>.dmg` (Intel) and `-arm64.dmg` (Apple Silicon). Without an Apple Developer certificate the app is unsigned — right-click → Open on first launch. Set `CSC_LINK`/`CSC_KEY_PASSWORD` to sign with a Developer ID certificate.

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
