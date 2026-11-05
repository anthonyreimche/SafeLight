// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The app's own window: its version, the native title-bar overlay colours, and
// the folder the OS asked it to open.

const BAR_HEIGHT = 38; // the top bars' h-[38px]
const OVERLAY_HEIGHT = 36; // 2px under the bar so its bottom border shows
const TRAFFIC_LIGHT_HEIGHT = 14;

/**
 * @param {{
 *   appVersion: () => string,
 *   BrowserWindow: { fromWebContents(contents: Electron.WebContents): Electron.BrowserWindow | null },
 *   takeOsOpen: () => unknown,
 * }} deps
 */
function windowChannels({ appVersion, BrowserWindow, takeOsOpen }) {
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
    // Privileged: it names a folder for the renderer to open as the project.
    {
      channel: "os-open:take",
      privileged: true,
      handler: () => takeOsOpen(),
    },
  ];
}

module.exports = { windowChannels };
