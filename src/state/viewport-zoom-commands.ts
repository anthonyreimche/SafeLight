// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Bridge between the central rebindable shortcuts (use-keyboard-shortcuts) and
// whichever image viewport is on screen: zoom level is owned by the viewport's
// parent (DevelopView / the loupe), not by a global store, so the mounted
// ViewportImage registers its zoom commands here and the shortcut handler
// drives the most recently mounted one. Per-window by nature — a detached
// module runs its own context with its own registration.

export interface ViewportZoomCommands {
  /** One keyboard zoom step (dir 1 = in, -1 = out), cursor-anchored. */
  zoomStep(dir: 1 | -1): void;
  zoomFit(): void;
  zoom100(): void;
}

const stack: ViewportZoomCommands[] = [];

/** Register the mounted viewport's commands; returns the unregister. */
export function registerViewportZoomCommands(c: ViewportZoomCommands): () => void {
  stack.push(c);
  return () => {
    const i = stack.lastIndexOf(c);
    if (i >= 0) stack.splice(i, 1);
  };
}

/** The active viewport's commands, or null when no viewport is mounted. */
export function viewportZoomCommands(): ViewportZoomCommands | null {
  return stack[stack.length - 1] ?? null;
}
