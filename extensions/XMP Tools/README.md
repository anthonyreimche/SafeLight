# XMP Tools

Optional SafeLight extension that owns all XMP functionality:

- **Read** XMP sidecar metadata (rating, label, flag, keywords) on photo import.
- **Write** sidecars on metadata changes and develop-edit commits (gated by the
  extension's "Write XMP sidecars" setting; off by default).
- **Delete** sidecars when photos are removed.
- **Import** Lightroom / Adobe Camera Raw `.xmp` presets in the Presets panel.

The app core knows nothing about XMP — it emits catalog lifecycle hooks
(`onPhotoImport`, `onMetadataChange`, `onEditCommit`, `onPhotoRemove`) and a
pluggable preset-importer, which this extension subscribes to.

This folder lives at the repo root and is **excluded from the main app build**
(`tsconfig.json` only includes `src`). It is its own package, built to a single
ESM bundle and copied into SafeLight's plugins directory like any installed
external extension.

## Build & install (development)

From the repo root:

```sh
npm run ext:xmp:install      # build dist/index.js, then copy into the plugins dir
```

Or from this folder:

```sh
node scripts/build.mjs        # bundle only → dist/index.js
node scripts/install.mjs      # bundle + copy into the plugins dir
```

The installer auto-detects SafeLight's `userData/plugins` directory (packaged
"Safelight" vs. dev `electron .` "safelight"). Override with either:

```sh
SAFELIGHT_PLUGINS_DIR=/path/to/plugins node scripts/install.mjs
node scripts/install.mjs --dir /path/to/plugins
```

Restart SafeLight (or toggle the extension in the Extensions manager) to load it.

## Test

```sh
npm test     # runs the XMP and Lightroom-import test scripts
```

(Uses `node --experimental-strip-types`; no test framework, matching the app's
existing test convention.)

## Scope

Mapped on Lightroom import: basic tone/color scalars, sharpening, noise
reduction, the 8-channel HSL mix, Process-2012 tone curves, and best-effort
color grading. Crop, transform, lens corrections, and masks are not imported
(core's `normalizeParams` fills unmapped fields with defaults). `.lrtemplate`
(Lua) and Capture One `.costyle` are out of scope.
