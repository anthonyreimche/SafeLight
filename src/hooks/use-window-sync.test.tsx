// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The main window's side of the pop-out protocol: a closing pop-out hands its
// module back, and a pop-out can ask the main window to go to another module.
// Messages arrive over a stand-in for the BroadcastChannel other windows post to.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { BroadcastMessage } from "@/state/broadcast";
import { useUIStore } from "@/state/ui-store";
import { registerModule, useRegistry } from "@/extensions/registry";
import { useWindowSync } from "./use-window-sync";

type Listener = (event: MessageEvent<BroadcastMessage>) => void;

class FakeChannel {
  static current: FakeChannel | null = null;
  private listeners = new Set<Listener>();
  constructor() {
    FakeChannel.current = this;
  }
  postMessage(): void {}
  addEventListener(_type: "message", listener: Listener): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: "message", listener: Listener): void {
    this.listeners.delete(listener);
  }
  deliver(data: BroadcastMessage): void {
    for (const l of [...this.listeners]) l(new MessageEvent("message", { data }));
  }
}

/** A message another window posted, arriving in this one. */
const receive = (message: BroadcastMessage) =>
  act(() => FakeChannel.current?.deliver(message));

const View = () => null;

beforeEach(() => {
  vi.stubGlobal("BroadcastChannel", FakeChannel);
  useRegistry.setState({ modules: {} });
  useUIStore.setState({ activeModule: "develop", detached: new Set() });
  window.history.replaceState({}, "", "/");
});

describe("a pop-out closing", () => {
  it("hands its module back to the main window", () => {
    registerModule("ext", { id: "map", label: "Map", component: View });
    useUIStore.setState({ detached: new Set(["map"]) });
    renderHook(() => useWindowSync());
    receive({ type: "attach", payload: { module: "map" } });
    expect(useUIStore.getState().detached.has("map")).toBe(false);
    expect(useUIStore.getState().activeModule).toBe("map");
  });

  it("stays put when the main window doesn't know the module", () => {
    useUIStore.setState({ detached: new Set(["ghost"]) });
    renderHook(() => useWindowSync());
    receive({ type: "attach", payload: { module: "ghost" } });
    expect(useUIStore.getState().detached.has("ghost")).toBe(false);
    expect(useUIStore.getState().activeModule).toBe("develop");
  });
});

describe("a pop-out navigating", () => {
  it("moves the main window by the main window's rules", () => {
    registerModule("ext", { id: "map", label: "Map", component: View });
    renderHook(() => useWindowSync());
    receive({ type: "navigate", payload: { module: "map" } });
    expect(useUIStore.getState().activeModule).toBe("map");
  });

  it("is ignored by another pop-out", () => {
    window.history.replaceState({}, "", "/?detached=book");
    renderHook(() => useWindowSync());
    receive({ type: "navigate", payload: { module: "library" } });
    expect(useUIStore.getState().activeModule).toBe("develop");
  });
});
