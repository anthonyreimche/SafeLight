// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The app's pop-out windows (a module's, Developer Tools') are opened by the
// main process from a kind and a module id, never by window.open: whoever holds
// a new window's object could claim its privileged bridge before its own
// bundle does.

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODULE_ID } from "@/extensions/registry";
import { MODULE_ID as MAIN_MODULE_ID, appWindowUrl, createAppWindows } from "./app-windows.cjs";

class FakeWindow extends EventEmitter {
  static made: FakeWindow[] = [];
  webContents = new EventEmitter();
  destroyed = false;
  minimized = false;
  focus = vi.fn();
  show = vi.fn();
  restore = vi.fn();
  loadURL = vi.fn(async () => {});
  constructor(public options: Record<string, unknown>) {
    super();
    FakeWindow.made.push(this);
  }
  isDestroyed() {
    return this.destroyed;
  }
  isMinimized() {
    return this.minimized;
  }
  close() {
    this.destroyed = true;
    this.emit("closed");
  }
}

const BASE = { show: false, webPreferences: { preload: "preload.cjs" } };

function windows() {
  return createAppWindows({ BrowserWindow: FakeWindow, windowOptions: () => ({ ...BASE }) });
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWindow.made = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("appWindowUrl", () => {
  it("builds the app's index URL for a module and for Developer Tools", () => {
    expect(appWindowUrl({ kind: "module", module: "library" })).toBe(
      "app://bundle/index.html?detached=library",
    );
    expect(appWindowUrl({ kind: "module", module: "core.map-2" })).toBe(
      "app://bundle/index.html?detached=core.map-2",
    );
    expect(appWindowUrl({ kind: "devtools" })).toBe("app://bundle/index.html?devtools=1");
  });

  it.each(["Map", "a&b", "", "../x", ".x", "a b", 42, null, undefined])(
    "refuses module id %s",
    (module) => {
      expect(() => appWindowUrl({ kind: "module", module })).toThrow();
    },
  );

  it.each([{ kind: "other" }, { kind: "__proto__" }, null, "module"])("refuses %s", (target) => {
    expect(() => appWindowUrl(target)).toThrow();
  });

  it("takes module ids by the same rule as the registry", () => {
    expect(MAIN_MODULE_ID.source).toBe(MODULE_ID.source);
  });
});

describe("createAppWindows", () => {
  it("opens one window per pop-out and focuses it the second time", () => {
    const app = windows();
    app.open({ kind: "module", module: "library" });
    app.open({ kind: "module", module: "library" });
    expect(FakeWindow.made).toHaveLength(1);
    const [win] = FakeWindow.made;
    expect(win.loadURL).toHaveBeenCalledOnce();
    expect(win.loadURL).toHaveBeenCalledWith("app://bundle/index.html?detached=library");
    expect(win.focus).toHaveBeenCalledOnce();
  });

  it("brings a minimized pop-out back", () => {
    const app = windows();
    app.open({ kind: "devtools" });
    const [win] = FakeWindow.made;
    win.minimized = true;
    app.open({ kind: "devtools" });
    expect(win.restore).toHaveBeenCalledOnce();
    expect(win.focus).toHaveBeenCalledOnce();
  });

  it("keeps each module and Developer Tools in their own window", () => {
    const app = windows();
    app.open({ kind: "module", module: "library" });
    app.open({ kind: "module", module: "develop" });
    app.open({ kind: "devtools" });
    expect(FakeWindow.made.map((w) => w.loadURL.mock.calls[0][0])).toEqual([
      "app://bundle/index.html?detached=library",
      "app://bundle/index.html?detached=develop",
      "app://bundle/index.html?devtools=1",
    ]);
  });

  it("sizes the window for its kind on top of the shared options", () => {
    const app = windows();
    app.open({ kind: "module", module: "library" });
    app.open({ kind: "devtools" });
    expect(FakeWindow.made[0].options).toEqual({ ...BASE, width: 1280, height: 860 });
    expect(FakeWindow.made[1].options).toEqual({ ...BASE, width: 760, height: 600 });
  });

  it("opens hidden and shows the window once it is ready", () => {
    windows().open({ kind: "devtools" });
    const [win] = FakeWindow.made;
    expect(win.show).not.toHaveBeenCalled();
    win.emit("ready-to-show");
    expect(win.show).toHaveBeenCalledOnce();
  });

  it("refuses a bad module id without opening anything", () => {
    const app = windows();
    expect(() => app.open({ kind: "module", module: "a&b" })).toThrow();
    expect(FakeWindow.made).toEqual([]);
  });

  it("opens a new window once the old one has closed", () => {
    const app = windows();
    app.open({ kind: "module", module: "library" });
    FakeWindow.made[0].close();
    app.open({ kind: "module", module: "library" });
    expect(FakeWindow.made).toHaveLength(2);
    expect(FakeWindow.made[1].focus).not.toHaveBeenCalled();
  });

  it("closes a pop-out by target, and ignores one that isn't open", () => {
    const app = windows();
    app.open({ kind: "module", module: "library" });
    app.open({ kind: "devtools" });
    app.close({ kind: "module", module: "library" });
    app.close({ kind: "module", module: "develop" });
    expect(FakeWindow.made.map((w) => w.destroyed)).toEqual([true, false]);
  });

  it("closes every pop-out when the main window closes", () => {
    const app = windows();
    const main = new FakeWindow({});
    app.setMain(main);
    app.open({ kind: "module", module: "library" });
    app.open({ kind: "devtools" });
    main.close();
    expect(FakeWindow.made.every((w) => w.destroyed)).toBe(true);
  });

  it("focuses the main window, restoring it when minimized", () => {
    const app = windows();
    const main = new FakeWindow({});
    app.setMain(main);
    main.minimized = true;
    app.focusMain();
    expect(main.restore).toHaveBeenCalledOnce();
    expect(main.focus).toHaveBeenCalledOnce();
  });

  it("does nothing for focusMain once the main window is gone", () => {
    const app = windows();
    const main = new FakeWindow({});
    app.setMain(main);
    main.close();
    expect(() => app.focusMain()).not.toThrow();
    expect(main.focus).not.toHaveBeenCalled();
  });
});
