#!/bin/sh
# Development launcher for slu: runs dist-cli/slu.mjs (npm run build:cli) with
# this repo's Electron as plain Node.
here=$(cd "$(dirname "$0")/.." && pwd)
case "$(uname -s)" in
  Darwin) electron="$here/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" ;;
  MINGW*|MSYS*|CYGWIN*) electron="$here/node_modules/electron/dist/electron.exe" ;;
  *) electron="$here/node_modules/electron/dist/electron" ;;
esac
ELECTRON_RUN_AS_NODE=1 exec "$electron" "$here/dist-cli/slu.mjs" "$@"
