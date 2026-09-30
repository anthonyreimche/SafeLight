// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Pop-out windows for registered modules. External plugins load after first
// paint, so the detached id is read raw; the main window hands over to the
// next attached module from the registry's tab order.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { detachModule, detachedModule, goToModule } from "./detach";
import { useUIStore } from "./ui-store";
import { registerModule, useRegistry } from "@/extensions/registry";
import { makeScopedAPI } from "@/extensions/host";

const View = () => null;

/** Every window this window has popped out, closed after each test so the next
 *  one opens its own. */
const opened: { closed: boolean; focus: Mock; close: Mock }[] = [];
const fakeWindow = () => {
  const win = { closed: false, focus: vi.fn(), close: vi.fn() };
  opened.push(win);
  return win;
};

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
  useUIStore.setState({ activeModule: "library", detached: new Set() });
  window.history.replaceState({}, "", "/");
  vi.stubGlobal("open", vi.fn(fakeWindow));
  vi.stubGlobal("BroadcastChannel", FakeChannel);
  posted.length = 0;
});

afterEach(() => {
  for (const win of opened) win.closed = true;
  opened.length = 0;
});

describe("detachedModule", () => {
  it("is null outside a detached window", () => {
    expect(detachedModule()).toBeNull();
  });

  it("reads a registered module's id before its extension has loaded", () => {
    window.history.replaceState({}, "", "/?detached=map");
    expect(detachedModule()).toBe("map");
  });

  it("still reads the built-ins", () => {
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

  it("opens the module's window under a name no module shares with Developer Tools", () => {
    detachModule("map");
    expect(window.open).toHaveBeenCalledWith(
      `${window.location.origin}/?detached=map`,
      "safelight-module-map",
      "width=1280,height=860",
    );
  });

  it("encodes the id so the pop-out reads back the id it was opened for", () => {
    detachModule("a&b");
    const url = String(vi.mocked(window.open).mock.calls[0][0]);
    expect(new URL(url).searchParams.get("detached")).toBe("a&b");
  });
});

describe("goToModule in the main window", () => {
  it("is what an extension's navigation.goTo calls", () => {
    expect(makeScopedAPI("ext").navigation.goTo).toBe(goToModule);
  });

  it("switches to a built-in or registered module", () => {
    registerModule("ext", { id: "map", label: "Map", component: View });
    goToModule("map");
    expect(useUIStore.getState().activeModule).toBe("map");
    goToModule("develop");
    expect(useUIStore.getState().activeModule).toBe("develop");
  });

  it("ignores a module that is neither built-in nor registered", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    goToModule("print");
    expect(useUIStore.getState().activeModule).toBe("library");
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("focuses a popped-out module's window instead of switching to its placeholder", () => {
    registerModule("ext", { id: "map", label: "Map", component: View });
    detachModule("map");
    const [win] = opened;
    win.focus.mockClear();
    goToModule("map");
    expect(win.focus).toHaveBeenCalledOnce();
    expect(useUIStore.getState().activeModule).toBe("library");
  });
});

describe("goToModule in a pop-out window", () => {
  let openerFocus: Mock;
  beforeEach(() => {
    window.history.replaceState({}, "", "/?detached=map");
    openerFocus = vi.fn();
    vi.stubGlobal("opener", { focus: openerFocus });
  });

  it("does nothing for the module the window shows", () => {
    goToModule("map");
    expect(posted).toEqual([]);
    expect(openerFocus).not.toHaveBeenCalled();
    expect(useUIStore.getState().activeModule).toBe("library");
  });

  it("asks the main window to go anywhere else, and brings it forward", () => {
    goToModule("develop");
    expect(posted).toEqual([{ type: "navigate", payload: { module: "develop" } }]);
    expect(openerFocus).toHaveBeenCalledOnce();
    expect(useUIStore.getState().activeModule).toBe("library");
  });
});
