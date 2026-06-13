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

### Windows

**Windows SmartScreen blocks the installer** — the installer is signed with a local self-signed certificate, so Windows may show "Windows protected your PC." Click **More info → Run anyway**. To suppress this permanently, run `make-cert.ps1` as Administrator once to install the `CN=Safelight` root certificate machine-wide.

**"WebGL2 not supported"** — update your graphics drivers and make sure hardware acceleration is enabled. The desktop app forces the high-performance GPU (D3D11 ANGLE, discrete adapter) automatically; the browser requires it to be enabled in `chrome://settings/system`.

**App won't launch / black window** — open Task Manager, kill any orphaned `Safelight` processes, then relaunch. If the window is black, ensure your GPU drivers are up to date and that hardware acceleration is not blocked by a group policy.

### macOS

**"Safelight is damaged and can't be opened" (Gatekeeper)** — the `.dmg` is unsigned unless you supplied a Developer ID certificate at build time. Run this once in Terminal after mounting the DMG:

```bash
xattr -cr /Applications/Safelight.app
```

Then right-click the app → **Open** on first launch to bypass the Gatekeeper dialog. Subsequent launches work normally.

**App is slow on Apple Silicon** — confirm Safelight is running natively (not under Rosetta 2): Activity Monitor → find Safelight → the Architecture column should say `Apple`. If it says `Intel`, reinstall from the `-arm64.dmg` build.

### Linux

**AppImage does nothing when double-clicked** — the file needs the executable bit:

```bash
chmod +x Safelight-<version>.AppImage
./Safelight-<version>.AppImage
```

**AppImage error: "fuse: device not found"** — FUSE 2 is required. Install it:

```bash
# Debian/Ubuntu
sudo apt install libfuse2
# Fedora
sudo dnf install fuse
# Arch
sudo pacman -S fuse2
```

Alternatively, extract and run without FUSE: `./Safelight-<version>.AppImage --appimage-extract && ./squashfs-root/AppRun`.

**Flatpak — app has no access to files** — Flatpak sandboxing restricts filesystem access. Grant the needed path with Flatseal or from the command line:

```bash
flatpak override --user --filesystem=host io.github.anthonyreimche.Safelight
```

**`.deb` / `.rpm` install fails with dependency errors** — install the missing system libraries first. Common culprits:

```bash
# Debian/Ubuntu
sudo apt install --fix-broken install
# Fedora
sudo dnf install libXScrnSaver libappindicator-gtk3
```

### RAW and image quality

**RAW files look soft or load as small previews (browser)** — full-speed RAW decoding requires cross-origin isolation (`SharedArrayBuffer`), which the plain Vite dev server does not guarantee. Use the desktop app for full-resolution decoding. If you must use the browser, start the dev server and confirm the console shows `Cross-Origin-Opener-Policy: same-origin`.

**Unsupported RAW format / file shows as grey tile** — Safelight falls back to the embedded JPEG preview if libraw-wasm can't decode the file. Very new camera models may need a libraw-wasm update. Check the [libraw supported cameras list](https://www.libraw.org/supported-cameras) and open a GitHub issue if your camera is listed but fails.

**Colors look wrong after decoding** — check that the correct camera profile is applied (Preferences ▸ Color). Some cameras benefit from a DCP profile; export the photo with the "Use embedded profile" option and compare.

### Projects and files

**Photos missing after restart (browser)** — folder permissions expire between browser sessions. Click **Reconnect** in the top bar to re-grant access; the desktop app is not affected once permission is granted.

**Edits lost / catalog not saving** — Safelight writes to `.safelight/` inside the project folder. Ensure the folder is not read-only and is not inside a path that sync software (OneDrive, Dropbox) has locked. If a sync conflict occurs, `.safelight/catalog.json` will have a backup alongside it — rename it to restore.

**Extension install fails ("Failed to fetch")** — extension installation downloads from GitHub. Check your internet connection and, on corporate networks, whether `raw.githubusercontent.com` is allowed through the firewall. You can also install extensions manually: clone the repo to a local folder, then drag-and-drop the folder onto the Extensions panel.

### Source builds

**`npm run build:electron` fails with "Cannot find module"** — make sure you're on Node.js 18 or newer (`node -v`) and that `npm install` completed without errors. Delete `node_modules/` and `package-lock.json` and re-run `npm install` if you see version conflicts.

**WSL2 Linux build fails with "rsync: command not found"** — install rsync in your WSL2 distro:

```bash
sudo apt install rsync   # Debian/Ubuntu
```

**Port already in use** — Vite automatically tries the next port (5174, 5175, …). If it keeps failing, find and kill the occupying process: `npx kill-port 5173`.
