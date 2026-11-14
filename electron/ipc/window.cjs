// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The app's own window: its version, the native title-bar overlay colours, and
// the folder the OS asked it to open.

const os = require("node:os");
const { applyMaterial, parseMaterial } = require("../window-material.cjs");

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const BAR_HEIGHT = 38; // the top bars' h-[38px]
const OVERLAY_HEIGHT = 36; // 2px under the bar so its bottom border shows
const TRAFFIC_LIGHT_HEIGHT = 14;

/**
 * @param {{
 *   appVersion: () => string,
 *   BrowserWindow: { fromWebContents(contents: Electron.WebContents): Electron.BrowserWindow | null },
 *   takeOsOpen: () => unknown,
 *   saveMaterial?: (material: "acrylic" | "mica" | null) => void,
 *   isSoftware?: () => boolean,
 *   appWindows: ReturnType<typeof import("../app-windows.cjs").createAppWindows>,
 * }} deps
 */
function windowChannels({ appVersion, BrowserWindow, takeOsOpen, saveMaterial, isSoftware, appWindows }) {
  return [
    {
      channel: "app:version",
      privileged: false,
      handler: () => appVersion(),
    },
    // Recolor the native min/max/close overlay to follow the in-app theme and
    // size it to the 38px bar under the Interface scale (Windows/Linux). macOS
    // has no overlay, so its traffic lights are re-centred in the scaled bar.
    {
      channel: "window:setTitleBarOverlay",
      privileged: false,
      handler: (e, color, symbolColor, uiScale) => {
        const win = BrowserWindow.fromWebContents(e.sender);
        if (!win) return;
        if (!HEX_COLOR.test(String(color)) || !HEX_COLOR.test(String(symbolColor))) {
          console.warn(`[safelight] title-bar overlay colours must be hex, got ${color} / ${symbolColor}`);
          return;
        }
        const scale = Number.isFinite(uiScale) && uiScale > 0 ? Number(uiScale) : 1;
        try {
          if (process.platform === "darwin") {
            win.setWindowButtonPosition({
              x: 12,
              y: Math.round((BAR_HEIGHT * scale - TRAFFIC_LIGHT_HEIGHT) / 2),
            });
            return;
          }
          win.setTitleBarOverlay({
            color: String(color),
            symbolColor: String(symbolColor),
            height: Math.round(OVERLAY_HEIGHT * scale),
          });
        } catch {}
      },
    },
    // Privileged: the window material is the system's to draw, so a theme asks
    // for it through the core only. Anything but a known material clears it.
    {
      channel: "window:setMaterial",
      privileged: true,
      handler: (e, material) => {
        const win = BrowserWindow.fromWebContents(e.sender);
        if (!win) return false;
        const wanted = parseMaterial(material);
        const system = {
          platform: process.platform,
          release: os.release(),
          software: isSoftware ? isSoftware() : false,
        };
        const applied = applyMaterial(win, wanted, system);
        if (system.platform === "win32" || system.platform === "darwin") saveMaterial?.(wanted);
        return applied;
      },
    },
    // Privileged so only core opens the app's pop-outs (app-windows.cjs).
    {
      channel: "window:openApp",
      privileged: true,
      handler: (_e, kind, module) => appWindows.open({ kind, module }),
    },
    {
      channel: "window:closeApp",
      privileged: true,
      handler: (_e, kind, module) => appWindows.close({ kind, module }),
    },
    {
      channel: "window:focusMain",
      privileged: true,
      handler: () => appWindows.focusMain(),
    },
    // Privileged: it names a folder for the renderer to open as the project.
    {
      channel: "os-open:take",
      privileged: true,
      handler: () => takeOsOpen(),
    },
  ];
}

module.exports = { windowChannels };
