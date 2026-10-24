// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The space the screen shows, which the live Develop view encodes version 3
// frames for. P3 on a wide-gamut display, sRGB on any other. Linux is always
// sRGB: Chromium doesn't colour-manage the window under Wayland, so the
// desktop (KDE Plasma) or the monitor profile (display-profile.ts) does that
// job there.

import { useSyncExternalStore } from "react";
import type { DisplaySpace } from "./color-space";
import { displayProfileSupported } from "./display-profile-store";

/** The query that says the display reaches P3, or null where the answer is sRGB
 *  without asking: Linux, or a browser with no matchMedia. */
function p3Query(): MediaQueryList | null {
  if (displayProfileSupported() || typeof window.matchMedia !== "function") return null;
  return window.matchMedia("(color-gamut: p3)");
}

const spaceFor = (p3: boolean): DisplaySpace => (p3 ? "display-p3" : "srgb");

export function currentDisplaySpace(): DisplaySpace {
  return spaceFor(p3Query()?.matches === true);
}

/** Follow the screen the window is on, which changes when it is dragged to
 *  another monitor. Returns the unsubscribe. */
export function subscribeDisplaySpace(listener: (space: DisplaySpace) => void): () => void {
  const query = p3Query();
  if (!query) return () => undefined;
  const onChange = () => listener(spaceFor(query.matches));
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

export function useDisplaySpace(): DisplaySpace {
  return useSyncExternalStore(subscribeDisplaySpace, currentDisplaySpace);
}
