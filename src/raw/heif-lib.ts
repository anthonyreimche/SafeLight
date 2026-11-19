// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The one libheif module of a thread, built on first use. Imported statically
// by heif.worker.ts and only dynamically elsewhere, so the 2 MB bundle loads
// where HEIF files are decoded and nowhere else.

import libheif, { type LibHeif } from "libheif-js/libheif-wasm/libheif-bundle.mjs";

let lib: LibHeif | null = null;

export function heifLib(): LibHeif {
  lib ??= libheif();
  return lib;
}

/** Drops a module that trapped: a wasm heap left mid-call can't be trusted. */
export function resetHeifLib(): void {
  lib = null;
}
