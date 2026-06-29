# Third-Party Notices

Safelight is distributed under the GNU GPL v3 (see [LICENSE](LICENSE)). It
includes, links against, or is distributed alongside third-party components that
remain under their own licenses. Their copyright notices and license terms are
preserved below as those licenses require. This file is part of the
"Appropriate Legal Notices" for the distributed app.

A complete, machine-generated list of bundled npm packages and their licenses can
be produced from the production dependency tree with:

```
npx license-checker-rseidelsohn --production --relativeLicensePath --files THIRD-PARTY-LICENSES
```

The components below are the ones whose licenses require explicit notice and/or an
offer of source.

## RAW decoding — LibRaw (via `libraw-wasm`)

RAW files are decoded by a WebAssembly build of **LibRaw**
(`src/raw/vendor/libraw-wasm/`, bundled into `dist/`). LibRaw is licensed under
your choice of the **GNU LGPL v2.1** or the **CDDL v1.0**. LibRaw incorporates
code derived from **dcraw** by Dave Coffin, distributed under dcraw's own terms.

- LibRaw: Copyright (C) 2008-2024 LibRaw LLC (https://www.libraw.org). LGPL-2.1 / CDDL-1.0.
- dcraw: Copyright (C) 1997-2018 Dave Coffin.

The WebAssembly module also statically includes:

- **Little CMS (lcms2)** — Copyright (C) 1998-2023 Marti Maria Saguer. MIT License.
- **libjpeg (IJG)** — Copyright (C) 1991-2020 Thomas G. Lane, Guido Vollbeding. Independent JPEG Group license.

**Offer of source (LGPL §6 / §4):** the complete corresponding source for LibRaw
and the above components, including the Emscripten build configuration used to
produce the bundled `.wasm`, is available on request from
**anthonyreimche@gmail.com**, and upstream at https://github.com/LibRaw/LibRaw.

## Desktop runtime — Electron / Chromium

The desktop builds are distributed on top of **Electron**, which bundles
**Node.js**, **Chromium**, and **ffmpeg**.

- Electron — Copyright (C) GitHub Inc. MIT License.
- Chromium — Copyright The Chromium Authors. BSD-3-Clause and many third-party
  licenses; the full set ships with Electron as `LICENSES.chromium.html`, which is
  included in the packaged application resources.
- ffmpeg (as built and shipped by Electron) — LGPL-2.1-or-later. Electron uses an
  LGPL-compatible ffmpeg build (no `--enable-gpl` codecs). Corresponding source for
  the exact version is published by the Electron project for each release.

## Bundled libraries (npm)

The following are compiled into `dist/` and ship in the app. All are permissive
and require their copyright notice be preserved:

- **React**, **react-dom**, **react-router-dom** — Copyright (C) Meta Platforms, Inc. MIT License.
- **Zustand** — Copyright (C) Paul Henschel / Poimandres. MIT License.
- **dockview / dockview-core** — Copyright (C) mathuo. MIT License.
- **utif2** — Copyright (C) Ivan Kuckir (Photopea). MIT License.
- **pako** — Copyright (C) Vitaly Puzrin, Andrei Tuputcyn. MIT License AND Zlib License.

The MIT and BSD license texts are reproduced in the GitHub repositories of each
project above and apply to the corresponding files.

## Build-time only (not distributed)

These are used to build Safelight but are **not** included in the shipped app, so
their copyleft terms do not extend to the distribution:

- **sharp** (Apache-2.0) and **libvips** (LGPL-3.0-or-later) — icon rasterization only.
- **lightningcss** (MPL-2.0) — CSS transformation at build time; its output is the
  project's own content, not Covered Software.

---

*If you believe a component is missing from this file or is attributed
incorrectly, please open an issue or contact anthonyreimche@gmail.com.*
