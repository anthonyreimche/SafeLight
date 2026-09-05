// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Dock layout persistence. Every case here is a restart: the layout is written
// to localStorage, the store is torn down, and DockHost is mounted again — the
// same path the app takes at boot. Covers side rails, the opt-in bottom rail
// (its height included), and saved user layouts.
//
// Dragging itself is pointer-and-geometry driven and stays manually verified;
// what these tests pin down is that whatever arrangement a drag produced comes
// back unchanged.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  DockHost,
  addUserLayout,
  applyDockLayout,
  toggleDockPanel,
  toggleDockPanelFloating,
  useDockStore,
  useUserLayouts,
  CUSTOM_LAYOUT,
} from "./dock";
import { registerPanel, useRegistry } from "./registry";

const LAYOUT_KEY = "sl_dock_layout_v4:develop";

const Empty = () => null;

/** Register a panel the way an extension would. */
function panel(id: string, extra: Parameters<typeof registerPanel>[1] | object = {}) {
  registerPanel("test-ext", {
    id,
    title: id,
    component: Empty,
    ...(extra as object),
  });
}

/** Mount the dock for a module — the app's boot path into loadModuleLayout. */
function boot(module: "library" | "develop" = "develop") {
  const view = render(<DockHost module={module}>{null}</DockHost>);
  return { close: () => view.unmount(), view };
}

/** Drag a rail's resize handle by `dy` px. The handler works off client coords
 *  alone (no layout), so jsdom can run the real thing. */
async function dragResize(handle: Element, dy: number) {
  await userEvent.pointer([
    { keys: "[MouseLeft>]", target: handle, coords: { clientX: 0, clientY: 200 } },
    { target: handle, coords: { clientX: 0, clientY: 200 + dy } },
    { keys: "[/MouseLeft]", target: handle },
  ]);
}

/** Let the debounced layout save (300ms) run. */
async function flushSave() {
  await act(() => new Promise((r) => setTimeout(r, 350)));
}

/** The saved arrangement, as the next launch would read it. */
function saved() {
  return JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null");
}

function rails() {
  return useDockStore.getState().rails;
}

beforeEach(() => {
  localStorage.clear();
  useRegistry.setState({ panels: {} });
  useUserLayouts.setState({ layouts: {} });
  useDockStore.setState({
    module: null,
    rails: [],
    floating: {},
    zOrder: [],
    collapsed: {},
    hidden: false,
    open: [],
    drag: null,
    target: null,
  });
  applyDockLayout(CUSTOM_LAYOUT);
});

afterEach(() => {
  localStorage.clear();
});

describe("saved layouts survive a restart", () => {
  it("restores a bottom rail with its height", () => {
    panel("ext.strip", { allowBottomDock: true, fill: true });
    localStorage.setItem(
      LAYOUT_KEY,
      JSON.stringify({
        rails: [
          { id: "left-default", side: "left", width: 300, panels: ["ext.side"] },
          { id: "bottom-1", side: "bottom", width: 280, height: 168, panels: ["ext.strip"] },
        ],
        floating: {},
        zOrder: [],
        collapsed: {},
      }),
    );
    panel("ext.side");

    const { close } = boot();
    expect(rails()).toEqual([
      { id: "left-default", side: "left", width: 300, panels: ["ext.side"] },
      { id: "bottom-1", side: "bottom", width: 280, height: 168, panels: ["ext.strip"] },
    ]);
    close();
  });

  it("keeps a resized bottom rail across the next launch", async () => {
    panel("ext.strip", {
      allowBottomDock: true,
      defaultDock: { module: "develop", direction: "bottom", height: 112 },
    });

    let session = boot();
    expect(rails()[0].height).toBe(112);

    // Drag the strip's top edge up 60px — a bottom rail grows as the pointer
    // rises.
    const handle = session.view.container.querySelector(".cursor-row-resize")!;
    await dragResize(handle, -60);
    expect(rails()[0].height).toBe(172);

    await flushSave();
    expect(saved().rails[0].height).toBe(172);
    session.close();

    session = boot();
    expect(rails()[0].height).toBe(172);
    session.close();
  });

  it("round-trips a bottom rail through a saved user layout", async () => {
    panel("ext.strip", { allowBottomDock: true });
    localStorage.setItem(
      LAYOUT_KEY,
      JSON.stringify({
        rails: [{ id: "bottom-1", side: "bottom", width: 280, height: 144, panels: ["ext.strip"] }],
        floating: {},
        zOrder: [],
        collapsed: {},
      }),
    );

    let session = boot();
    let id = "";
    act(() => {
      id = addUserLayout("Culling");
    });
    expect(useUserLayouts.getState().layouts[id].modules.develop).toEqual({
      rails: [{ side: "bottom", width: 280, height: 144, panels: ["ext.strip"] }],
    });
    session.close();

    // Switch away and back: the named layout rebuilds the same bottom rail.
    act(() => applyDockLayout(CUSTOM_LAYOUT));
    act(() => applyDockLayout(id));
    session = boot();
    expect(rails()).toEqual([
      { id: "develop-bottom-0", side: "bottom", width: 280, height: 144, panels: ["ext.strip"] },
    ]);
    session.close();
  });
});

describe("bottom rails are opt-in", () => {
  it("keeps a panel whose extension hasn't registered yet", () => {
    // Extensions load asynchronously: the dock can mount before the strip's
    // bundle has been imported, and an unknown id must not be evicted.
    localStorage.setItem(
      LAYOUT_KEY,
      JSON.stringify({
        rails: [{ id: "bottom-1", side: "bottom", width: 280, height: 112, panels: ["ext.strip"] }],
        floating: {},
        zOrder: [],
        collapsed: {},
      }),
    );

    const { close } = boot();
    expect(rails()[0].panels).toEqual(["ext.strip"]);
    close();
  });

  it("drops a registered vertical panel a previous build let into the strip", () => {
    panel("ext.strip", { allowBottomDock: true });
    panel("ext.histogram"); // no opt-in: a column, not a strip
    localStorage.setItem(
      LAYOUT_KEY,
      JSON.stringify({
        rails: [
          {
            id: "bottom-1",
            side: "bottom",
            width: 280,
            height: 112,
            panels: ["ext.strip", "ext.histogram"],
          },
        ],
        floating: {},
        zOrder: [],
        collapsed: {},
      }),
    );

    const { close } = boot();
    expect(rails()[0].panels).toEqual(["ext.strip"]);
    expect(useDockStore.getState().open).not.toContain("ext.histogram");
    close();
  });

  it("treats a bottom defaultDock as opting in", () => {
    panel("ext.strip", {
      defaultDock: { module: "develop", direction: "bottom", height: 96 },
    });
    const { close } = boot();
    expect(rails()).toEqual([
      { id: "bottom-default", side: "bottom", width: 280, height: 96, panels: ["ext.strip"] },
    ]);
    close();
  });
});

describe("collapsing a bottom rail", () => {
  /** Click a panel header without moving — the dock's collapse gesture. */
  async function clickHeader(view: { container: HTMLElement }, title: string) {
    const header = [...view.container.querySelectorAll("[data-dock-panel] span")].find(
      (el) => el.textContent === title,
    )!;
    await userEvent.pointer([
      { keys: "[MouseLeft>]", target: header, coords: { clientX: 40, clientY: 400 } },
      { keys: "[/MouseLeft]", target: header },
    ]);
  }

  it("folds down to the header instead of holding the band open", async () => {
    panel("ext.strip", {
      allowBottomDock: true,
      fill: true,
      defaultDock: { module: "develop", direction: "bottom", height: 140 },
    });
    const { close, view } = boot();

    const railEl = () => view.container.querySelector<HTMLElement>("[data-rail]")!;
    expect(railEl().style.height).toBe("140px");
    expect(view.container.querySelector(".cursor-row-resize")).not.toBeNull();

    await clickHeader(view, "ext.strip");
    expect(useDockStore.getState().collapsed["ext.strip"]).toBe(true);
    // No fixed height: the rail is now as tall as its header, and there is no
    // band left to resize.
    expect(railEl().style.height).toBe("");
    expect(view.container.querySelector(".cursor-row-resize")).toBeNull();

    await clickHeader(view, "ext.strip");
    expect(railEl().style.height).toBe("140px");
    close();
  });

  it("keeps the band while a sibling is still expanded", async () => {
    // The rail takes its height from the first panel in the group.
    panel("ext.strip", {
      allowBottomDock: true,
      defaultDock: { module: "develop", direction: "bottom", order: 1, height: 140 },
    });
    panel("ext.notes", {
      allowBottomDock: true,
      defaultDock: { module: "develop", direction: "bottom", order: 2 },
    });
    const { close, view } = boot();

    await clickHeader(view, "ext.notes");
    expect(view.container.querySelector<HTMLElement>("[data-rail]")!.style.height).toBe(
      "140px",
    );
    close();
  });
});

describe("toggling a panel from the View menu", () => {
  it("opens it floating centered instead of re-docking at its default", () => {
    panel("ext.strip", {
      allowBottomDock: true,
      defaultDock: { module: "develop", direction: "bottom", height: 112 },
    });
    const { close } = boot();

    act(() => toggleDockPanelFloating("ext.strip"));
    expect(useDockStore.getState().open).toEqual([]);

    act(() => toggleDockPanelFloating("ext.strip"));
    expect(rails()).toEqual([]);
    expect(useDockStore.getState().floating["ext.strip"]).toEqual({
      x: 0,
      y: 0,
      width: 320,
      centered: true,
    });

    act(() => toggleDockPanelFloating("ext.strip"));
    expect(useDockStore.getState().open).toEqual([]);
    close();
  });

  it("pins the window to the workspace center until it's dragged", () => {
    panel("ext.notes");
    const { close, view } = boot();

    act(() => toggleDockPanelFloating("ext.notes"));
    const win = view.container.querySelector<HTMLElement>(".shadow-2xl")!;
    expect(win.style.left).toBe("calc(50% + 0px)");
    expect(win.style.top).toBe("calc(50% + 0px)");
    expect(win.style.transform).toBe("translate(-50%, -50%)");
    close();
  });

  it("staggers a second centered window so the first stays visible", () => {
    panel("ext.a");
    panel("ext.b");
    const { close } = boot();

    act(() => toggleDockPanelFloating("ext.a"));
    act(() => toggleDockPanelFloating("ext.b"));
    expect(useDockStore.getState().floating["ext.b"]).toEqual({
      x: 24,
      y: 24,
      width: 320,
      centered: true,
    });
    close();
  });

  it("resizing a centered window keeps it centered", async () => {
    panel("ext.notes");
    const { close, view } = boot();

    act(() => toggleDockPanelFloating("ext.notes"));
    const handle = view.container.querySelector(".shadow-2xl .cursor-col-resize")!;
    await userEvent.pointer([
      { keys: "[MouseLeft>]", target: handle, coords: { clientX: 100, clientY: 0 } },
      { target: handle, coords: { clientX: 160, clientY: 0 } },
      { keys: "[/MouseLeft]", target: handle },
    ]);
    expect(useDockStore.getState().floating["ext.notes"]).toEqual({
      x: 0,
      y: 0,
      width: 380,
      centered: true,
    });
    close();
  });

  it("keeps a centered window centered across a restart", async () => {
    panel("ext.notes");
    let session = boot();

    act(() => toggleDockPanelFloating("ext.notes"));
    await flushSave();
    session.close();

    session = boot();
    expect(useDockStore.getState().open).toEqual(["ext.notes"]);
    expect(useDockStore.getState().floating["ext.notes"]).toEqual({
      x: 0,
      y: 0,
      width: 320,
      centered: true,
    });
    session.close();
  });
});

describe("reopening a panel", () => {
  it("re-docks it at its default instead of floating", () => {
    panel("ext.strip", {
      allowBottomDock: true,
      defaultDock: { module: "develop", direction: "bottom", height: 112 },
    });
    const { close } = boot();

    act(() => toggleDockPanel("ext.strip"));
    expect(rails()).toEqual([]);
    expect(useDockStore.getState().open).toEqual([]);

    act(() => toggleDockPanel("ext.strip"));
    expect(rails()).toEqual([
      { id: expect.any(String), side: "bottom", width: 280, height: 112, panels: ["ext.strip"] },
    ]);
    close();
  });
});
