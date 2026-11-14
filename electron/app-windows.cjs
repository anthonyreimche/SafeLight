// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The app's pop-out windows: a module in its own window, and Developer Tools.
// The main process opens them, never window.open. Extensions share the main
// window's realm, and a page holding a new window's object can call that
// window's claimPrivileged() before the window's own bundle has loaded, taking
// its privileged fs and update bridge. Core asks for a pop-out by kind and
// module id over a privileged channel; the URL is built here.

"use strict";

const { revealWhenReady } = require("./window-reveal.cjs");

/** The same rule as MODULE_ID in src/extensions/registry.ts. */
const MODULE_ID = /^[a-z0-9][a-z0-9._-]*$/;

const SIZES = {
  module: { width: 1280, height: 860 },
  devtools: { width: 760, height: 600 },
};

/** The window's registry name, its URL and its size; throws for anything that
 *  isn't a known kind with a valid module id. */
function describeTarget(target) {
  const kind = target && typeof target === "object" ? target.kind : undefined;
  if (kind === "devtools") {
    return {
      name: "safelight-devtools",
      url: "app://bundle/index.html?devtools=1",
      size: SIZES.devtools,
    };
  }
  if (kind === "module") {
    const { module } = target;
    if (typeof module !== "string" || !MODULE_ID.test(module)) {
      throw new Error(`Bad module id: ${String(module)}`);
    }
    return {
      name: `safelight-module-${module}`,
      url: `app://bundle/index.html?detached=${module}`,
      size: SIZES.module,
    };
  }
  throw new Error(`Unknown app window: ${String(kind)}`);
}

/** @param {{ kind: "module", module: string } | { kind: "devtools" }} target */
function appWindowUrl(target) {
  return describeTarget(target).url;
}

/**
 * @param {{
 *   BrowserWindow: new (options: object) => Electron.BrowserWindow,
 *   windowOptions: () => object,
 * }} deps `windowOptions` is what every pop-out shares (hidden at first, the
 *   title bar, the material, the preload and isolation settings).
 */
function createAppWindows({ BrowserWindow, windowOptions }) {
  const open = new Map();
  let main = null;

  const live = (win) => win && !win.isDestroyed();

  const bringForward = (win) => {
    if (win.isMinimized()) win.restore();
    win.focus();
  };

  return {
    /** Focuses the target's window if it is open, else opens it. */
    open(target) {
      const { name, url, size } = describeTarget(target);
      const existing = open.get(name);
      if (live(existing)) {
        bringForward(existing);
        return;
      }
      const win = new BrowserWindow({ ...windowOptions(), ...size });
      open.set(name, win);
      win.on("closed", () => {
        if (open.get(name) === win) open.delete(name);
      });
      revealWhenReady(win, () => win.show());
      win.loadURL(url).catch((err) => console.warn(`[safelight] ${url} did not load: ${err.message}`));
    },

    close(target) {
      const win = open.get(describeTarget(target).name);
      if (live(win)) win.close();
    },

    focusMain() {
      if (live(main)) bringForward(main);
    },

    /** The pop-outs close with `win`, as window.open children closed with
     *  their opener. */
    setMain(win) {
      main = win;
      win.on("closed", () => {
        if (main === win) main = null;
        for (const popOut of open.values()) if (live(popOut)) popOut.close();
      });
    },
  };
}

module.exports = { MODULE_ID, appWindowUrl, createAppWindows };
