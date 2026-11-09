// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The main window's side of the pop-out protocol: a closing pop-out hands its
// module back, a reloading one takes it again, and a pop-out can ask the main
// window to go to another module.
// Messages arrive over a stand-in for the BroadcastChannel other windows post to.

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { BroadcastMessage } from "@/state/broadcast";
import { useUIStore } from "@/state/ui-store";
import { useCatalogStore } from "@/state/catalog-store";
import { setThumbnailLoader } from "@/state/thumbnail-loader";
import { photo, installMemoryStorage } from "@/catalog/stored-edit.fixtures";
import { registerModule, useRegistry } from "@/extensions/registry";
import { registerEssentialModules } from "@/test/essential-modules.test-support";
import { useWindowSync } from "./use-window-sync";

type Listener = (event: MessageEvent<BroadcastMessage>) => void;

class FakeChannel {
  static current: FakeChannel | null = null;
  private listeners = new Set<Listener>();
  constructor() {
    FakeChannel.current = this;
  }
  postMessage(_message: BroadcastMessage): void {}
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

describe("a pop-out reloading", () => {
  beforeEach(() => {
    registerEssentialModules();
    registerModule("ext", { id: "map", label: "Map", component: View });
  });

  it("takes its module back, and the main window returns to where it was", () => {
    renderHook(() => useWindowSync());
    receive({ type: "attach", payload: { module: "map" } });
    receive({ type: "detach", payload: { module: "map" } });
    expect(useUIStore.getState().detached.has("map")).toBe(true);
    expect(useUIStore.getState().activeModule).toBe("develop");
  });

  it("moves the main window to the first tab still in it when there is nowhere to return to", () => {
    useUIStore.setState({ activeModule: "map" });
    renderHook(() => useWindowSync());
    receive({ type: "detach", payload: { module: "map" } });
    expect(useUIStore.getState().detached.has("map")).toBe(true);
    expect(useUIStore.getState().activeModule).toBe("library");
  });

  it("announces itself when it opens", () => {
    window.history.replaceState({}, "", "/?detached=map");
    const post = vi.spyOn(FakeChannel.prototype, "postMessage");
    onTestFinished(() => post.mockRestore());
    renderHook(() => useWindowSync());
    expect(post).toHaveBeenCalledWith({ type: "detach", payload: { module: "map" } });
  });

  it("is ignored by another pop-out", () => {
    window.history.replaceState({}, "", "/?detached=book");
    useUIStore.setState({ detached: new Set(["develop"]) });
    renderHook(() => useWindowSync());
    receive({ type: "attach", payload: { module: "develop" } });
    receive({ type: "detach", payload: { module: "map" } });
    expect(useUIStore.getState().activeModule).toBe("develop");
    expect([...useUIStore.getState().detached]).toEqual(["develop"]);
  });
});

describe("a photo's preview changing", () => {
  const readPreview = vi.fn(async (_id: string): Promise<Blob | null> => null);

  beforeEach(() => {
    readPreview.mockClear();
    setThumbnailLoader(readPreview);
    installMemoryStorage();
    useCatalogStore.setState({ photos: [photo("a"), photo("b")] });
  });

  afterEach(() => {
    setThumbnailLoader(null);
  });

  it("reloads that preview when another window rewrote it", () => {
    renderHook(() => useWindowSync());
    receive({ type: "catalog-change", payload: { action: "update", id: "a", origin: "other" } });
    expect(readPreview).toHaveBeenCalledTimes(1);
    expect(readPreview).toHaveBeenCalledWith("a");
  });

  it("doesn't reload when this window rates a photo", async () => {
    renderHook(() => useWindowSync());
    await useCatalogStore.getState().setRating("a", 4);
    expect(readPreview).not.toHaveBeenCalled();
  });

  it("doesn't reload the previews this window turned itself", async () => {
    renderHook(() => useWindowSync());
    await useCatalogStore.getState().rotatePhotos(["a", "b"], 90);
    expect(readPreview).not.toHaveBeenCalled();
  });
});
