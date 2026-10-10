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
import { openSetup, resetSetupForTests } from "@/modules/welcome/setup/setup-store";

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

describe("App welcome setup", () => {
  beforeEach(() => {
    localStorage.clear();
    resetSetupForTests();
  });

  afterEach(() => {
    unregisterExtension("ext");
    vi.unstubAllGlobals();
  });

  it("shows the setup layer over a project in the main window", async () => {
    registerModule("ext", { id: "map", label: "Map", component: () => <p>map-main</p> });
    useUIStore.setState({ activeModule: "map" });
    render(<App />);
    act(() => openSetup("rerun"));
    expect(
      await screen.findByRole("dialog", { name: "Pick a look" }),
    ).toBeTruthy();
  });

  it("shows a plain fill instead of the welcome grid while deciding", async () => {
    // Without the bridge the decision is synchronous; with it, it waits on the
    // installed-extension count, which this holds back.
    let release!: (installed: unknown[]) => void;
    const held = new Promise<unknown[]>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal("safelightNative", { plugins: { list: () => held } });
    useProjectStore.setState({ root: null });
    render(<App />);
    expect(screen.queryByText("Recent projects")).toBeNull();
    await act(async () => release([{ id: "acme.widget" }]));
    expect(await screen.findByText("Recent projects")).toBeTruthy();
  });

  it("never shows setup in a detached module window", async () => {
    registerModule("ext", { id: "map", label: "Map", component: () => <p>map-main</p> });
    window.history.replaceState({}, "", "/?detached=map");
    render(<App />);
    act(() => openSetup("rerun"));
    await act(async () => {});
    expect(screen.queryByRole("dialog", { name: "Pick a look" })).toBeNull();
  });
});
