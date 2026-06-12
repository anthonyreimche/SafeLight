#!/usr/bin/env bash
# ============================================================================
#  Safelight - build one Linux package target with electron-builder.
#  Invoked by _build-linux.bat inside WSL2 with cwd = repo root.
#  Sources are rsynced to a native ext4 dir so the Linux node_modules never
#  collides with the Windows one on NTFS (and npm/vite run far faster there).
#  Usage: linux-build.sh <deb|rpm|pacman|AppImage|flatpak>
# ============================================================================
set -euo pipefail

TARGET="${1:?usage: linux-build.sh <deb|rpm|pacman|AppImage|flatpak>}"
SRC="$(pwd)"
BUILD="$HOME/.cache/safelight-linux-build"

command -v rsync >/dev/null 2>&1 || {
  echo "ERROR: rsync not found. Run: sudo apt install rsync"; exit 1; }

# Vite 8 needs Node 20.19+/22.12+. Bootstrap Node 22 via nvm when missing/old.
NODE_MAJ="$(node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/' || true)"
if [ "${NODE_MAJ:-0}" -lt 20 ]; then
  echo "Node ${NODE_MAJ:-not found} is too old (need 20+) - bootstrapping Node 22 via nvm..."
  export NVM_DIR="$HOME/.nvm"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  fi
  set +u  # nvm.sh references unbound vars
  . "$NVM_DIR/nvm.sh"
  nvm install 22
  nvm use 22
  set -u
fi
echo "Using node $(node -v)"

if [ "$TARGET" = "pacman" ] && ! command -v bsdtar >/dev/null 2>&1; then
  echo "ERROR: bsdtar not found (fpm needs it for pacman packages). Run: sudo apt install libarchive-tools"
  exit 1
fi
if [ "$TARGET" = "rpm" ] && ! command -v rpmbuild >/dev/null 2>&1; then
  echo "ERROR: rpmbuild not found (fpm needs it for rpm packages). Run: sudo apt install rpm"
  exit 1
fi
if [ "$TARGET" = "flatpak" ]; then
  # Surface the real flatpak error instead of "status code 1".
  export DEBUG="@malept/flatpak-bundler${DEBUG:+,$DEBUG}"
  for ref in org.freedesktop.Platform//24.08 org.freedesktop.Sdk//24.08 org.electronjs.Electron2.BaseApp//24.08; do
    flatpak info "$ref" >/dev/null 2>&1 || {
      echo "ERROR: flatpak runtime $ref not installed. Run:"
      echo "  flatpak install -y flathub $ref"
      exit 1
    }
  done
fi
if [ "$TARGET" = "flatpak" ] && ! command -v flatpak-builder >/dev/null 2>&1; then
  echo "ERROR: flatpak-builder not found. One-time setup inside WSL:"
  echo "  sudo apt install flatpak flatpak-builder"
  echo "  flatpak remote-add --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo"
  echo "  flatpak install -y flathub org.freedesktop.Platform//24.08 \\"
  echo "    org.freedesktop.Sdk//24.08 org.electronjs.Electron2.BaseApp//24.08"
  exit 1
fi

echo "[1/4] Syncing sources to $BUILD ..."
mkdir -p "$BUILD"
rsync -a --delete \
  --exclude=/node_modules --exclude=/release --exclude=/dist --exclude=/.git \
  "$SRC"/ "$BUILD"/
cd "$BUILD"

echo "[2/4] Installing dependencies..."
# Reinstall when the lockfile changed OR node_modules was built by another
# Node major (native bindings like rolldown/sharp are version-specific).
STAMP="node_modules/.node-major"
CUR_MAJ="$(node -v | cut -d. -f1)"
if [ "$(cat "$STAMP" 2>/dev/null)" = "$CUR_MAJ" ] && [ node_modules/.package-lock.json -nt package-lock.json ]; then
  echo "    node_modules up to date - skipping npm install."
else
  rm -rf node_modules
  npm install --no-audit --no-fund
  echo "$CUR_MAJ" > "$STAMP"
fi

echo "[3/4] Building web app (tsc + vite)..."
rm -rf dist
npm run build

echo "[4/4] Packaging $TARGET (electron-builder)..."
npx electron-builder --linux "$TARGET" --publish never

OUT="$SRC/release/linux"
mkdir -p "$OUT"
find release -maxdepth 1 -type f \
  \( -name '*.deb' -o -name '*.rpm' -o -name '*.pacman' \
     -o -name '*.AppImage' -o -name '*.flatpak' \) \
  -exec cp -v {} "$OUT/" \;
