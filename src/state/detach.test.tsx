// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Pop-out windows for registered modules. External plugins load after first
// paint, so the detached id is read raw; the main window hands over to the
// next attached module from the registry's tab order.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachModule, detachModule, detachedModule, focusDetached, goToModule } from "./detach";
import { useUIStore } from "./ui-store";
import { registerModule, useRegistry } from "@/extensions/registry";
import { registerEssentialModules } from "@/test/essential-modules.test-support";
import { makeScopedAPI } from "@/extensions/host";
import { detachDevtools } from "@/extensions/devtools/detach";
import { toggleDockPanelFloating, useDockStore } from "@/extensions/dock";

const View = () => null;

// Pop-outs are opened by the main process through core's privileged window
// bridge. window.open would hand this window the pop-out's object, and with it
// a race for the pop-out's privileged bridge.
const native = vi.hoisted(() => ({
  present: true,
  bridge: {
    setMaterial: vi.fn(async () => true),
    openApp: vi.fn(async () => {}),
    closeApp: vi.fn(async () => {}),
    focusMain: vi.fn(async () => {}),
  },
}));
vi.mock("@/native/privileged", () => ({
  privilegedWindow: () => (native.present ? native.bridge : null),
}));

const openerReads = vi.fn();

/** What this window has sent the others over the sync channel. */
const posted: unknown[] = [];
class FakeChannel {
  postMessage(message: unknown): void {
    posted.push(message);
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

beforeEach(() => {
  useRegistry.setState({ modules: {} });
  registerEssentialModules();
  useUIStore.setState({ activeModule: "library", detached: new Set() });
  window.history.replaceState({}, "", "/");
  vi.stubGlobal("open", vi.fn());
  Object.defineProperty(window, "opener", { configurable: true, get: openerReads });
  vi.stubGlobal("BroadcastChannel", FakeChannel);
  posted.length = 0;
  native.present = true;
  for (const call of Object.values(native.bridge)) call.mockClear();
  openerReads.mockClear();
});

afterEach(() => {
  expect(window.open).not.toHaveBeenCalled();
  expect(openerReads).not.toHaveBeenCalled();
});

describe("detachedModule", () => {
  it("is null outside a detached window", () => {
    expect(detachedModule()).toBeNull();
  });

  it("reads a registered module's id before its extension has loaded", () => {
    window.history.replaceState({}, "", "/?detached=map");
    expect(detachedModule()).toBe("map");
  });

  it("reads Library and Develop", () => {
    window.history.replaceState({}, "", "/?detached=develop");
    expect(detachedModule()).toBe("develop");
  });

  it("rejects an id that is not a plain identifier", () => {
    window.history.replaceState({}, "", "/?detached=%3Cscript%3E");
    expect(detachedModule()).toBeNull();
  });

  it("rejects an id registerModule would refuse", () => {
    window.history.replaceState({}, "", "/?detached=Map");
    expect(detachedModule()).toBeNull();
  });
});

describe("detachModule", () => {
  it("hands the main window to the next attached module when the active one pops out", () => {
    registerModule("ext", { id: "map", label: "Map", component: View });
    useUIStore.setState({ activeModule: "map" });
    detachModule("map");
    expect(useUIStore.getState().detached.has("map")).toBe(true);
    expect(useUIStore.getState().activeModule).toBe("library");
  });

  it("skips modules that are already popped out when choosing the next one", () => {
    registerModule("ext", { id: "book", label: "Book", component: View });
    useUIStore.setState({ activeModule: "library", detached: new Set(["develop"]) });
    detachModule("library");
    expect(useUIStore.getState().activeModule).toBe("book");
  });

  it("asks the main process for the module's window", () => {
    detachModule("map");
    expect(native.bridge.openApp.mock.calls).toEqual([["module", "map"]]);
  });

  it("leaves the module in place where there is no native window bridge", () => {
    native.present = false;
    useUIStore.setState({ activeModule: "map" });
    detachModule("map");
    expect(useUIStore.getState().detached.has("map")).toBe(false);
    expect(useUIStore.getState().activeModule).toBe("map");
  });
});

describe("focusDetached and attachModule", () => {
  it("asks for the module's window again, which the main process only focuses", () => {
    focusDetached("map");
    expect(native.bridge.openApp.mock.calls).toEqual([["module", "map"]]);
  });

  it("closes the module's window and shows the module here", () => {
    useUIStore.setState({ activeModule: "library", detached: new Set(["develop"]) });
    attachModule("develop");
    expect(native.bridge.closeApp.mock.calls).toEqual([["module", "develop"]]);
    expect(useUIStore.getState().detached.has("develop")).toBe(false);
    expect(useUIStore.getState().activeModule).toBe("develop");
  });
});

describe("detachDevtools", () => {
  it("asks the main process for the Developer Tools window and closes the docked panel", () => {
    useDockStore.setState({ rails: [], floating: {}, zOrder: [], open: [] });
    toggleDockPanelFloating("core.devtools");
    expect(useDockStore.getState().open).toContain("core.devtools");
    detachDevtools();
    expect(native.bridge.openApp.mock.calls).toEqual([["devtools"]]);
    expect(useDockStore.getState().open).not.toContain("core.devtools");
  });
});

describe("goToModule in the main window", () => {
  it("is what an extension's navigation.goTo calls", () => {
    expect(makeScopedAPI("ext").navigation.goTo).toBe(goToModule);
  });

  it("switches to any registered module, Develop among them", () => {
    registerModule("ext", { id: "map", label: "Map", component: View });
    goToModule("map");
    expect(useUIStore.getState().activeModule).toBe("map");
    goToModule("develop");
    expect(useUIStore.getState().activeModule).toBe("develop");
  });

  it("ignores a module that is not registered", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    goToModule("print");
    expect(useUIStore.getState().activeModule).toBe("library");
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("focuses a popped-out module's window instead of switching to its placeholder", () => {
    registerModule("ext", { id: "map", label: "Map", component: View });
    detachModule("map");
    native.bridge.openApp.mockClear();
    goToModule("map");
    expect(native.bridge.openApp.mock.calls).toEqual([["module", "map"]]);
    expect(useUIStore.getState().activeModule).toBe("library");
  });
});

describe("goToModule in a pop-out window", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/?detached=map");
  });

  it("does nothing for the module the window shows", () => {
    goToModule("map");
    expect(posted).toEqual([]);
    expect(native.bridge.focusMain).not.toHaveBeenCalled();
    expect(useUIStore.getState().activeModule).toBe("library");
  });

  it("asks the main window to go anywhere else, and brings it forward", () => {
    goToModule("develop");
    expect(posted).toEqual([{ type: "navigate", payload: { module: "develop" } }]);
    expect(native.bridge.focusMain).toHaveBeenCalledOnce();
    expect(useUIStore.getState().activeModule).toBe("library");
  });
});
