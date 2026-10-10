// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Each warmed decoder instance holds a 256 MB WASM heap, so only a window that
// decodes RAWs pays for them: the main window, or a Develop window popped out of
// it. Other pop-outs and the DevTools window never open a project to decode.
export function shouldWarmDecodePool(detached: string | null): boolean {
  return detached === null || detached === "develop";
}
