# Installation

Safelight ships as a packaged desktop app for **Windows** (recommended), **Linux** (packages for every major distro family), and **macOS**, plus a **browser app** run from source. The desktop app guarantees the fast RAW decode path and full GPU acceleration; the browser version is handy for development.

If a prebuilt installer doesn't run on your machine, you can always build your own from source — every release artifact is produced by the same `npm` + `electron-builder` toolchain documented in [Building from source](#building-from-source), and none of it requires the helper `.bat` files.

## Contents

- [Prebuilt downloads](#prebuilt-downloads) — Windows, Linux, macOS
- [Requirements](#requirements)
- [Build toolchain overview](#build-toolchain-overview) — what the npm scripts do
- [Building from source](#building-from-source)
  - [Windows installer](#windows-installer)
  - [macOS .dmg](#macos-dmg)
  - [Linux packages](#linux-packages)
  - [Production web build](#production-web-build)
- [Running from source (dev)](#running-from-source-dev)
- [Troubleshooting](#troubleshooting)

---

## Prebuilt downloads

### Windows desktop app

Download and run the latest `Safelight Setup <version>.exe` from the [releases page](../../releases). The installer (NSIS) lets you pick the install directory and creates desktop / Start-menu shortcuts. It is signed with a local self-signed certificate, so SmartScreen may warn on first run — see [Troubleshooting → Windows](#windows).

### Linux desktop app

Download the package for your distro from the releases page:

| Package | Distros | Install command |
|---|---|---|
| `safelight_<version>_amd64.deb` | Debian, Ubuntu, Mint | `sudo apt install ./safelight_<version>_amd64.deb` |
| `safelight-<version>.x86_64.rpm` | Fedora, openSUSE, RHEL | `sudo dnf install ./safelight-<version>.x86_64.rpm` |
| `safelight-<version>.pacman` | Arch, Manjaro, EndeavourOS | `sudo pacman -U safelight-<version>.pacman` |
| `Safelight-<version>.AppImage` | any distro, no install | `chmod +x` the file and run it |
| `safelight_<version>_amd64.flatpak` | any distro with Flatpak | `flatpak install ./safelight_<version>_amd64.flatpak` |

### macOS desktop app

macOS builds are produced by the `build-macos-dmg.sh` script (see [below](#macos-dmg)) and may not be attached to every release. If no `.dmg` is published for your release, build one yourself on a Mac. Output is `Safelight-<version>.dmg` (Intel) and `Safelight-<version>-arm64.dmg` (Apple Silicon).

---

## Requirements

**To run** (any prebuilt app):

- A GPU with **WebGL2** — all image processing is GPU-accelerated.
- For the **browser** version: a recent Chromium-based browser (Chrome, Edge, Opera, Brave). Safelight depends on the File System Access API for project folders, so Firefox and Safari are not supported for full functionality.

**To build from source:**

- **Node.js 20.19+ or 22.12+** (Node **22 LTS** recommended). Vite 8 requires these minimums — Node 18 will fail the build. Check with `node -v`.
- **npm** (bundled with Node) and **git**.
- Platform packaging tools, only for building installers — listed per-target [below](#building-from-source).

---

## Build toolchain overview

Everything is driven by the npm scripts in `package.json`; the `.bat`/`.sh` files in `build-scripts/` are convenience wrappers that call these same commands and handle per-OS setup.

| Script | What it does |
|---|---|
| `npm install` | Install dependencies (run once, and after pulling changes). |
| `npm run dev` | Vite dev server (browser) at `http://localhost:5173`. |
| `npm run build` | Type-check (`tsc`) + Vite production build → `dist/`. |
| `npm run preview` | Serve the production `dist/` locally. |
| `npm run icon` | Generate `build/icon.ico` / `icon.png` from `public/favicon.svg`. |
| `npm run electron:dev` | Build the renderer and open it in an Electron window. |
| `npm run build:electron` | `build` + `icon` + `electron-builder --win` → Windows installer in `release/`. |
| `npm run build:linux` | `build` + `icon` + `electron-builder --linux` → Linux package(s) in `release/`. |

The packaging step is [electron-builder](https://www.electron.build/), configured under the `build` key in `package.json` (app id, targets, icons, Linux dependencies, NSIS options). To target a specific format, call electron-builder directly, e.g. `npx electron-builder --linux deb`. Output always lands in `release/`.

> **Cross-compilation rule:** electron-builder can build Windows and Linux targets from most hosts, but **macOS `.dmg` packages can only be built on macOS** (they need `hdiutil`/`codesign`). Linux native packages are easiest to build on Linux; on Windows, the helper scripts run them inside WSL2.

---

## Building from source

Common first steps on every OS:

```bash
git clone https://github.com/anthonyreimche/SafeLight.git
cd SafeLight
npm install
```

Then follow the section for the installer you want.

### Windows installer

Produces a single signed `Safelight Setup <version>.exe` (NSIS) in `release/`.

**Prerequisites:** Node.js 20+ and npm. PowerShell (built into Windows) is used only for the optional code-signing certificate.

**Option A — one-click script (recommended):**

Double-click **`build-scripts\build-electron-windows-exe.bat`** (or run it from a terminal). It installs dependencies if needed, cleans `dist/`, builds the web app, generates the icon, creates/loads a self-signed certificate (`CN=Safelight`), signs and packages the installer, and prunes `release/` to the single `.exe`. Run it **as Administrator** if you want the certificate trusted machine-wide.

**Option B — manual commands (no `.bat`):**

```powershell
npm run build
npm run icon
npx electron-builder --win --publish never
```

This leaves `Safelight Setup <version>.exe` plus `win-unpacked/`, `.blockmap`, and `.yml` files in `release/`; only the `.exe` is needed to install.

**Code signing (optional).** Without a certificate the installer still works but shows "Unknown Publisher" and triggers SmartScreen. To sign with the local self-signed cert:

```powershell
powershell -ExecutionPolicy Bypass -File make-cert.ps1   # creates build\safelight-cert.pfx, trusts it locally
$env:CSC_LINK = "$PWD\build\safelight-cert.pfx"
$env:CSC_KEY_PASSWORD = "safelight"
npx electron-builder --win --publish never
```

A self-signed cert is trusted only on machines where it's installed; removing SmartScreen warnings for everyone requires a CA-issued certificate (set `CSC_LINK`/`CSC_KEY_PASSWORD` to that instead). See `make-cert.ps1` for details.

### macOS .dmg

Produces `Safelight-<version>.dmg` (Intel) and `Safelight-<version>-arm64.dmg` (Apple Silicon) in `release/`. **Must be run on a Mac.**

**Prerequisites:** macOS with Node.js 20+ (`brew install node` or [nodejs.org](https://nodejs.org)). Xcode command-line tools provide `hdiutil`/`codesign` (`xcode-select --install`).

**Option A — script:**

```bash
bash build-scripts/build-macos-dmg.sh
```

**Option B — manual commands:**

```bash
npm run build
npm run icon
export CSC_IDENTITY_AUTO_DISCOVERY=false   # skip signing for a local/unsigned build
npx electron-builder --mac dmg --publish never
```

**Signing (optional).** Without an Apple Developer certificate the `.dmg` is unsigned and Gatekeeper warns on first launch (right-click → **Open**, or see [Troubleshooting → macOS](#macos)). To sign, export your Developer ID certificate and set `CSC_LINK` (path to the `.p12`) and `CSC_KEY_PASSWORD` before running electron-builder, and omit `CSC_IDENTITY_AUTO_DISCOVERY=false`.

### Linux packages

electron-builder targets: `deb`, `rpm`, `pacman`, `AppImage`, `flatpak`. Output goes to `release/` (or `release/linux/` when built through the Windows wrappers).

#### On Linux (native)

**Prerequisites:** Node.js 20+ (use [nvm](https://github.com/nvm-sh/nvm) if your distro ships an older Node). Extra tools per target:

| Target | Extra requirement |
|---|---|
| `deb` | none beyond electron-builder |
| `rpm` | `rpmbuild` — `sudo apt install rpm` / `sudo dnf install rpm-build` |
| `pacman` | `bsdtar` — `sudo apt install libarchive-tools` (or `pacman -S libarchive`) |
| `AppImage` | none (FUSE 2 needed only to *run* the result) |
| `flatpak` | `flatpak` + `flatpak-builder`, plus the runtimes below |

**Build a single target directly:**

```bash
npm run build
npm run icon
npx electron-builder --linux deb        # or rpm / pacman / AppImage / flatpak
```

Or use the shared helper, which also handles the per-target tooling checks:

```bash
bash build-scripts/linux-build.sh deb   # deb | rpm | pacman | AppImage | flatpak
```

**Flatpak one-time setup:**

```bash
sudo apt install flatpak flatpak-builder
flatpak remote-add --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo
flatpak install -y flathub \
  org.freedesktop.Platform//24.08 \
  org.freedesktop.Sdk//24.08 \
  org.electronjs.Electron2.BaseApp//24.08
```

#### On Windows (via WSL2)

Linux targets can't be packaged natively on Windows, so the wrappers run electron-builder inside **WSL2**. **Prerequisites:** WSL2 (`wsl --install`) with a distro that has `rsync` (and Node 20+ — the script bootstraps Node 22 via nvm if yours is older).

Double-click any of:

- `build-scripts\build-linux-deb.bat`
- `build-scripts\build-linux-rpm.bat`
- `build-scripts\build-linux-arch-pacman.bat`
- `build-scripts\build-linux-appimage.bat`
- `build-scripts\build-linux-flatpak.bat`

Sources are rsynced to a native ext4 directory inside WSL (`~/.cache/safelight-linux-build`) so the Linux `node_modules` never collides with the Windows one; the finished package is copied back to `release/linux/`, and a build log is written to `release/linux-build-<target>.log`.

#### On macOS

You can also build Linux packages from a Mac the same way as on Linux (`npx electron-builder --linux <target>`), provided the target's tooling (`rpmbuild`, etc.) is installed via Homebrew.

> **Why a desktop app at all?** RAW decoding runs libraw-wasm on shared memory in a worker, which requires a cross-origin-isolated secure context. The Electron shell serves the app over a privileged `app://` scheme with COOP/COEP headers and pins Chromium to the fast GPU path (discrete GPU, D3D11 ANGLE, no software fallback). See [Architecture](../dev/architecture.md#electron-shell).

### Production web build

To host Safelight yourself or test the optimized bundle:

```bash
npm run build      # tsc + vite build → dist/
npm run preview    # serve dist/ locally
```

To get full-resolution RAW decoding in a browser, the server **must** send cross-origin-isolation headers so `SharedArrayBuffer` is available:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without them, Safelight still runs but falls back to embedded RAW previews. The Electron app sets these automatically.

---

## Running from source (dev)

1. **Clone and install** (see [above](#building-from-source)).

2. **Start the dev server:**

   ```bash
   npm run dev
   ```

   Vite serves at `http://localhost:5173` (or the next free port). On Windows you can double-click **`start.bat`**, which installs dependencies on first run and starts the server.

3. **Desktop window in dev:** `npm run electron:dev` builds the renderer and opens it in Electron — use this when testing file access, RAW, or GPU paths.

---

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
sudo apt --fix-broken install
# Fedora
sudo dnf install libXScrnSaver libappindicator-gtk3
```

### RAW and image quality

**RAW files look soft or load as small previews (browser)** — full-speed RAW decoding requires cross-origin isolation (`SharedArrayBuffer`), which the plain Vite dev server does not guarantee. Use the desktop app for full-resolution decoding. If you must use the browser, confirm the server sends `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`.

**Unsupported RAW format / file shows as grey tile** — Safelight falls back to the embedded JPEG preview if libraw-wasm can't decode the file. Very new camera models may need a libraw-wasm update. Check the [libraw supported cameras list](https://www.libraw.org/supported-cameras) and open a GitHub issue if your camera is listed but fails.

**Colors look wrong after decoding** — check that the correct camera profile is applied (Preferences ▸ Color). Some cameras benefit from a DCP profile; export the photo with the "Use embedded profile" option and compare.

### Projects and files

**Photos missing after restart (browser)** — folder permissions expire between browser sessions. Click **Reconnect** in the top bar to re-grant access; the desktop app is not affected once permission is granted.

**Edits lost / catalog not saving** — Safelight writes to `.safelight/` inside the project folder. Ensure the folder is not read-only and is not inside a path that sync software (OneDrive, Dropbox) has locked. If a sync conflict occurs, `.safelight/catalog.json` will have a backup alongside it — rename it to restore.

**Extension install fails ("Failed to fetch")** — extension installation downloads from GitHub. Check your internet connection and, on corporate networks, whether `raw.githubusercontent.com` is allowed through the firewall. You can also install extensions manually: clone the repo to a local folder, then drag-and-drop the folder onto the Extensions panel.

### Source builds

**Build fails with a Node/engine error or "Cannot find module"** — confirm you're on **Node 20.19+ or 22.12+** (`node -v`); Vite 8 rejects Node 18. Delete `node_modules/` and `package-lock.json` and re-run `npm install` if you see version conflicts. On Linux/macOS use [nvm](https://github.com/nvm-sh/nvm) to install Node 22.

**WSL2 Linux build fails with "rsync: command not found"** — install rsync in your WSL2 distro: `sudo apt install rsync`.

**Linux `pacman`/`rpm` build fails** — install the packaging tool the target needs: `pacman` → `sudo apt install libarchive-tools` (provides `bsdtar`); `rpm` → `sudo apt install rpm`.

**`electron-builder` can't download Electron / times out** — it caches binaries in `~/.cache/electron` and `~/.cache/electron-builder`; on a restricted network, set `ELECTRON_MIRROR` or pre-seed the cache, then re-run.

**Port already in use** — Vite automatically tries the next port (5174, 5175, …). If it keeps failing, find and kill the occupying process: `npx kill-port 5173`.
