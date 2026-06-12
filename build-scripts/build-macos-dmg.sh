#!/usr/bin/env bash
# ============================================================================
#  Safelight - build the macOS .dmg installer (x64 + Apple Silicon).
#  macOS packages can ONLY be built on a Mac (electron-builder needs
#  hdiutil/codesign). Run from anywhere: bash build-scripts/build-macos-dmg.sh
#  Output: release/Safelight-<version>.dmg and -arm64.dmg
#  Unsigned by default (no Apple Developer cert): Gatekeeper will warn on
#  first launch; users right-click > Open. Set CSC_LINK/CSC_KEY_PASSWORD to
#  sign with a Developer ID certificate.
# ============================================================================
set -euo pipefail

if [ "$(uname)" != "Darwin" ]; then
  echo "ERROR: macOS installers can only be built on a Mac."
  exit 1
fi

cd "$(dirname "${BASH_SOURCE[0]}")/.."

command -v node >/dev/null 2>&1 || {
  echo "ERROR: node not found. Install Node 20+ (https://nodejs.org or brew install node)."; exit 1; }

echo "[1/4] Installing dependencies..."
if [ node_modules/.package-lock.json -nt package-lock.json ]; then
  echo "    node_modules up to date - skipping npm install."
else
  npm install --no-audit --no-fund
fi

echo "[2/4] Building web app (tsc + vite)..."
rm -rf dist
npm run build

echo "[3/4] Generating icon..."
npm run icon

echo "[4/4] Packaging .dmg (electron-builder)..."
# Skip signing unless a cert is provided; unsigned builds still run locally.
if [ -z "${CSC_LINK:-}" ]; then
  export CSC_IDENTITY_AUTO_DISCOVERY=false
fi
npx electron-builder --mac dmg --publish never

echo
echo "DONE. Installers are in release/:"
ls -lh release/*.dmg
