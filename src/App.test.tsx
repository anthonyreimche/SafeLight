// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The main window routes to an extension-registered module, and hands back to
// Library when that module's extension goes away under it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { App } from "./App";
import { useUIStore } from "@/state/ui-store";
import { useProjectStore } from "@/project/project-store";
import { registerModule, unregisterExtension, useRegistry } from "@/extensions/registry";

/** The main window has no other windows to sync with here. */
class SilentChannel {
  postMessage(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

beforeEach(() => {
  vi.stubGlobal("BroadcastChannel", SilentChannel);
  useRegistry.setState({ modules: {} });
  useUIStore.setState({ activeModule: "library", detached: new Set() });
  useProjectStore.setState({
    root: { name: "shoot" } as unknown as FileSystemDirectoryHandle,
  });
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  useProjectStore.setState({ root: null });
});

describe("App", () => {
  it("shows a registered module that is active in the main window", () => {
    registerModule("ext", { id: "map", label: "Map", component: () => <p>map-main</p> });
    useUIStore.setState({ activeModule: "map" });
    render(<App />);
    expect(screen.getByText("map-main")).toBeTruthy();
  });

  it("falls back to Library when the active module's extension is swept", () => {
    registerModule("ext", { id: "map", label: "Map", component: () => <p>map-main</p> });
    useUIStore.setState({ activeModule: "map" });
    render(<App />);
    act(() => unregisterExtension("ext"));
    expect(useUIStore.getState().activeModule).toBe("library");
    expect(screen.queryByText("map-main")).toBeNull();
    expect(screen.getByText("0 photos in catalog")).toBeTruthy();
  });
});
