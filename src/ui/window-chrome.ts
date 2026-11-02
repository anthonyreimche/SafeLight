// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Shared drag styles for the top bars that double as the OS window title bar
// (Electron titleBarStyle:'hidden' — see electron/main.cjs). Empty bar space
// drags the window via `dragBarStyle`; interactive children opt back out with
// `noDragStyle`. We also reserve room for the OS-drawn controls: traffic lights
// on the left (macOS) or the min/max/close overlay on the right (Windows/Linux).

import { useEffect, type CSSProperties } from "react";
import { useThemeStore } from "@/extensions/themes";
import { useSettings } from "@/state/settings-store";

// csstype here predates the -webkit-app-region property, so augment it locally.
type AppRegionStyle = CSSProperties & { WebkitAppRegion?: "drag" | "no-drag" };

const isMac = window.safelightNative?.platform === "darwin";

// The OS draws the controls at a fixed window size while the body's CSS zoom
// (the Interface scale) multiplies every CSS length, so the reserved room is
// divided by the scale to stay the controls' real width.
const OVERLAY_WIDTH = 138;
const TRAFFIC_LIGHTS_WIDTH = 78;

export const dragBarStyle: AppRegionStyle = {
  WebkitAppRegion: "drag",
  ...(isMac
    ? { paddingLeft: `calc(${TRAFFIC_LIGHTS_WIDTH}px / var(--ui-scale, 1))` }
    : { paddingRight: `calc(${OVERLAY_WIDTH}px / var(--ui-scale, 1))` }),
};

export const noDragStyle: AppRegionStyle = { WebkitAppRegion: "no-drag" };

function applyOverlay(bgVar: string, uiScale: number): void {
  const cs = getComputedStyle(document.documentElement);
  const bg = cs.getPropertyValue(bgVar).trim();
  const fg = cs.getPropertyValue("--color-text-secondary").trim();
  if (bg && fg) void window.safelightNative?.titlebar?.setOverlay(bg, fg, uiScale);
}

// Every mounted bar in mount order; the last one owns the overlay. A layer
// over a bar (the welcome setup over the app) hands it back when it unmounts.
// A commit runs every cleanup before any setup, so a theme change refills the
// stack in tree order and the later sibling ends on top again.
const overlayStack: { bgVar: string }[] = [];

/**
 * Recolor the native window-controls overlay (Windows/Linux) so the min/max/close
 * buttons sit on the same background as *this* surface's header. Each top bar
 * passes the CSS var that drives its own background (the welcome and app views
 * share one window but use different surfaces). Re-runs on theme change so the
 * colors keep tracking the active theme, and sends the Interface scale so the
 * native controls grow with the bar. On macOS only the traffic lights move.
 */
export function useTitleBarOverlay(bgVar: string): void {
  // Subscribing to the active theme id re-fires the effect after a theme switch,
  // once applyTheme has written the new CSS vars onto :root.
  const activeId = useThemeStore((s) => s.activeId);
  const uiScale = useSettings((s) => s.uiScale);
  useEffect(() => {
    document.documentElement.style.setProperty("--ui-scale", String(uiScale));
    // Its own object, so two bars on the same var stay separate entries.
    const entry = { bgVar };
    overlayStack.push(entry);
    applyOverlay(bgVar, uiScale);
    return () => {
      overlayStack.splice(overlayStack.indexOf(entry), 1);
      const top = overlayStack.at(-1);
      if (top) applyOverlay(top.bgVar, uiScale);
    };
  }, [bgVar, activeId, uiScale]);
}
