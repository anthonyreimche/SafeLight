// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A registered module renders inside the shell; an unknown one falls back to
// Library in the main window and shows a placeholder in a detached window
// (external plugins load after first paint, so "unknown" may be "not yet").

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { ModuleView } from "./ModuleView";
import { useUIStore } from "@/state/ui-store";
import { registerModule, registerPanel, useRegistry } from "@/extensions/registry";
import { useExternalPluginsSettled } from "@/extensions/loader";
import { useDockStore } from "@/extensions/dock";

/** A component that throws while rendering. React still logs an error a
 *  boundary caught, so a test rendering one silences console.error. */
const boom = (message: string) => () => {
  throw new Error(message);
};
const silenceCaughtErrors = () => vi.spyOn(console, "error").mockImplementation(() => {});

beforeEach(() => {
  localStorage.clear();
  useRegistry.setState({ modules: {}, panels: {} });
  useUIStore.setState({ activeModule: "library", detached: new Set() });
  useExternalPluginsSettled.setState({ settled: false });
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ModuleView", () => {
  it("renders a registered module's view and status bar inside the shell", () => {
    registerModule("ext", {
      id: "map",
      label: "Map",
      component: () => <div>map-main</div>,
      statusBar: () => <span>map-status</span>,
    });
    render(<ModuleView id="map" />);
    expect(screen.getByText("map-main")).toBeTruthy();
    expect(screen.getByText("map-status")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Views" })).toBeTruthy();
  });

  it("falls back to Library in the main window when the module is unknown", () => {
    useUIStore.setState({ activeModule: "map" });
    const { container } = render(<ModuleView id="map" />);
    expect(useUIStore.getState().activeModule).toBe("library");
    expect(container.textContent).toBe("");
  });

  it("waits for the extension in a detached window until plugins have settled", () => {
    window.history.replaceState({}, "", "/?detached=map");
    render(<ModuleView id="map" />);
    expect(screen.getByText("Waiting for the map extension…")).toBeTruthy();
    expect(useUIStore.getState().activeModule).toBe("library");
  });

  it("reports an unavailable module once plugins have settled", () => {
    window.history.replaceState({}, "", "/?detached=map");
    useExternalPluginsSettled.setState({ settled: true });
    render(<ModuleView id="map" />);
    expect(
      screen.getByText("map isn't available in this window. Enable its extension, or re-attach."),
    ).toBeTruthy();
  });

  it("waits rather than taking a prototype key for a registered module", () => {
    window.history.replaceState({}, "", "/?detached=constructor");
    render(<ModuleView id="constructor" />);
    expect(screen.getByText("Waiting for the constructor extension…")).toBeTruthy();
  });

  it("swaps the placeholder for the module once it registers", () => {
    window.history.replaceState({}, "", "/?detached=map");
    render(<ModuleView id="map" />);
    act(() => {
      registerModule("ext", { id: "map", label: "Map", component: () => <div>map-main</div> });
    });
    expect(screen.getByText("map-main")).toBeTruthy();
    expect(screen.queryByText(/Waiting for/)).toBeNull();
  });

  it("seeds the module's default layout in a pop-out once it registers", () => {
    window.history.replaceState({}, "", "/?detached=map");
    render(<ModuleView id="map" />);
    expect(useDockStore.getState().rails).toEqual([]);
    act(() => {
      registerPanel("ext", { id: "ext.track", title: "Track", component: () => null });
      registerModule("ext", {
        id: "map",
        label: "Map",
        component: () => <div>map-main</div>,
        defaultLayout: { rails: [{ side: "right", width: 260, panels: ["ext.track"] }] },
      });
    });
    expect(useDockStore.getState().rails.map((r) => [r.side, r.width, r.panels])).toEqual([
      ["right", 260, ["ext.track"]],
    ]);
  });
});

describe("a module that throws while rendering", () => {
  it("keeps the top bar and tabs, and shows the crash in the main view", () => {
    silenceCaughtErrors();
    registerModule("ext", { id: "map", label: "Map", component: boom("boom") });
    render(<ModuleView id="map" />);
    expect(screen.getByRole("navigation", { name: "Views" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Extensions" })).toBeTruthy();
    expect(screen.getByText('Module "Map" crashed: boom')).toBeTruthy();
  });

  it("keeps the main view when only its status bar throws", () => {
    silenceCaughtErrors();
    registerModule("ext", {
      id: "map",
      label: "Map",
      component: () => <div>map-main</div>,
      statusBar: boom("no count"),
    });
    render(<ModuleView id="map" />);
    expect(screen.getByText("map-main")).toBeTruthy();
    expect(screen.getByText('Module "Map" status bar crashed: no count')).toBeTruthy();
  });

  it("does not carry one module's crash over to the next", () => {
    silenceCaughtErrors();
    registerModule("ext", { id: "map", label: "Map", component: boom("boom") });
    registerModule("ext", { id: "book", label: "Book", component: () => <div>book-main</div> });
    const { rerender } = render(<ModuleView id="map" />);
    rerender(<ModuleView id="book" />);
    expect(screen.getByText("book-main")).toBeTruthy();
  });
});
