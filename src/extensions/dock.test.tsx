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

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  DockHost,
  addUserLayout,
  applyDockLayout,
  initDockLayouts,
  toggleDockPanel,
  toggleDockPanelFloating,
  updateUserLayout,
  useDockStore,
  useUserLayouts,
  CUSTOM_LAYOUT,
  panelReplacements,
  replacePanelIds,
  type DockPlacement,
} from "./dock";
import {
  registerLayout,
  registerModule,
  registerPanel,
  unregisterExtension,
  useRegistry,
} from "./registry";

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
function boot(module: string = "develop") {
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
  useRegistry.setState({ panels: {}, modules: {}, layouts: {} });
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
    act(() => {
      void applyDockLayout(CUSTOM_LAYOUT);
    });
    act(() => {
      void applyDockLayout(id);
    });
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

describe("a panel that throws while rendering", () => {
  it("shows its crash in its own body while the rest of the dock renders", () => {
    // React still logs an error a boundary caught.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    panel("ext.bad", {
      component: () => {
        throw new Error("boom");
      },
      defaultDock: { module: "develop", direction: "left", order: 1 },
    });
    panel("ext.good", {
      component: () => <p>still here</p>,
      defaultDock: { module: "develop", direction: "left", order: 2 },
    });
    const { close, view } = boot();
    expect(view.getByText('Panel "ext.bad" crashed: boom').className).toBe(
      "p-3 text-[11px] text-red-400",
    );
    expect(view.getByText("still here")).toBeTruthy();
    close();
    error.mockRestore();
  });
});

describe("registered modules", () => {
  const mapLayout = {
    rails: [
      { side: "left" as const, width: 240, panels: ["core.folders"] },
      { side: "right" as const, width: 280, panels: ["ext.track"] },
      { side: "bottom" as const, height: 112, panels: ["ext.strip"] },
    ],
  };

  function registerMap() {
    panel("core.folders");
    panel("ext.track");
    panel("ext.strip", { allowBottomDock: true, fill: true });
    registerModule("test-ext", {
      id: "map",
      label: "Map",
      component: Empty,
      defaultLayout: mapLayout,
    });
  }

  it("seeds a registered module's rails from its defaultLayout", () => {
    registerMap();
    const { close } = boot("map");
    expect(rails().map((r) => [r.side, r.panels])).toEqual([
      ["left", ["core.folders"]],
      ["right", ["ext.track"]],
      ["bottom", ["ext.strip"]],
    ]);
    expect(rails().find((r) => r.side === "bottom")?.height).toBe(112);
    close();
  });

  it("resolves a layout preset without an entry for the module to its defaultLayout", () => {
    registerMap();
    registerLayout("test-ext", {
      id: "test.preset",
      name: "Preset",
      modules: { develop: { rails: [{ side: "left", panels: ["ext.track"] }] } },
    });
    applyDockLayout("test.preset");
    const { close } = boot("map");
    expect(rails().map((r) => [r.side, r.panels])).toEqual([
      ["left", ["core.folders"]],
      ["right", ["ext.track"]],
      ["bottom", ["ext.strip"]],
    ]);
    close();
  });

  it("opens the panels a defaultLayout floats, as a layout preset does", () => {
    panel("ext.track");
    panel("ext.notes");
    registerModule("test-ext", {
      id: "map",
      label: "Map",
      component: Empty,
      defaultLayout: {
        rails: [{ side: "right", width: 280, panels: ["ext.track"] }],
        floating: { "ext.notes": { x: 40, y: 60, width: 300 } },
      },
    });
    const { close } = boot("map");
    expect(useDockStore.getState().floating).toEqual({
      "ext.notes": { x: 40, y: 60, width: 300 },
    });
    expect(useDockStore.getState().zOrder).toEqual(["ext.notes"]);
    expect(useDockStore.getState().open).toEqual(["ext.track", "ext.notes"]);
    close();
  });

  it("seeds only the defaultLayout panels that are registered", () => {
    // core.folders, core.filters and core.info can each be disabled.
    panel("ext.track");
    registerModule("test-ext", {
      id: "map",
      label: "Map",
      component: Empty,
      defaultLayout: {
        rails: [
          { side: "left", width: 240, panels: ["core.folders", "core.filters"] },
          { side: "right", width: 280, panels: ["core.info", "ext.track"] },
        ],
        floating: { "core.info": { x: 40, y: 60, width: 300 } },
      },
    });
    const { close } = boot("map");
    expect(rails().map((r) => [r.side, r.panels])).toEqual([["right", ["ext.track"]]]);
    expect(useDockStore.getState().floating).toEqual({});
    expect(useDockStore.getState().open).toEqual(["ext.track"]);
    close();
  });

  it("falls back to defaultDock placements for a module without a defaultLayout", () => {
    panel("ext.side", { defaultDock: { module: "map", direction: "right", width: 200 } });
    registerModule("test-ext", { id: "map", label: "Map", component: Empty });
    const { close } = boot("map");
    expect(rails().map((r) => [r.side, r.panels])).toEqual([["right", ["ext.side"]]]);
    close();
  });

  it("never takes a prototype key for a saved layout's module entry", () => {
    addUserLayout("Mine");
    const { close } = boot("constructor");
    expect(rails()).toEqual([]);
    close();
  });

  it("captures a registered module in a saved user layout", () => {
    registerMap();
    const { close } = boot("map");
    const id = addUserLayout("Mine");
    const captured = useUserLayouts.getState().layouts[id]?.modules?.map;
    expect(captured?.rails.map((r) => r.panels)).toEqual([
      ["core.folders"],
      ["ext.track"],
      ["ext.strip"],
    ]);
    close();
  });

  it("keeps a module's entry when a layout is updated while its extension is off", () => {
    panel("ext.track");
    registerModule("map-ext", {
      id: "map",
      label: "Map",
      component: Empty,
      defaultLayout: { rails: [{ side: "right", width: 280, panels: ["ext.track"] }] },
    });
    const id = addUserLayout("Mine");
    const mapEntry = useUserLayouts.getState().layouts[id]?.modules?.map;
    expect(mapEntry).toBeDefined();

    unregisterExtension("map-ext");
    updateUserLayout(id);
    expect(useUserLayouts.getState().layouts[id]?.modules?.map).toEqual(mapEntry);
  });
});

describe("panel replacement helpers", () => {
  const reg = (ids: Record<string, readonly string[] | undefined>) =>
    Object.fromEntries(
      Object.entries(ids).map(([id, replaces]) => [
        id,
        { id, title: id, component: Empty, extensionId: "test-ext", ...(replaces ? { replaces } : {}) },
      ]),
    );
  const place = (over: Partial<DockPlacement> = {}): DockPlacement => ({
    rails: [],
    floating: {},
    zOrder: [],
    collapsed: {},
    ...over,
  });

  it("maps an old id to the panel that replaces it", () => {
    expect(panelReplacements(reg({ "x.new": ["x.old"] }))).toEqual(new Map([["x.old", "x.new"]]));
  });

  it("leaves an old id that is still registered to its own panel", () => {
    expect(panelReplacements(reg({ "x.old": undefined, "x.new": ["x.old"] })).size).toBe(0);
  });

  it("ignores a panel replacing its own id", () => {
    expect(panelReplacements(reg({ "x.new": ["x.new"] })).size).toBe(0);
  });

  // The warned set is module-level, so this test's ids are not reused anywhere else.
  it("gives a contested old id to the first panel registered, and warns once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const both = reg({ "claim.first": ["claim.old"], "claim.second": ["claim.old"] });
      expect(panelReplacements(both).get("claim.old")).toBe("claim.first");
      panelReplacements(both);
      expect(warn.mock.calls).toEqual([
        ['[dock] panel "claim.second" also replaces "claim.old"; "claim.first" keeps it.'],
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it("ignores a replaces that is not an array, rather than iterating it", () => {
    // A plain-JS extension can pass anything; a string would iterate by character
    // and a number would throw on the dock load path.
    const bad = (replaces: unknown) => reg({ "x.new": replaces as readonly string[] });
    expect(panelReplacements(bad("x.old")).size).toBe(0);
    expect(panelReplacements(bad(42)).size).toBe(0);
  });

  it("skips replaces entries that are not strings", () => {
    const mixed = [42, null, "x.old"] as unknown as readonly string[];
    expect(panelReplacements(reg({ "x.new": mixed }))).toEqual(new Map([["x.old", "x.new"]]));
  });

  it("renames an old id in place", () => {
    const out = replacePanelIds(
      place({ rails: [{ id: "r", side: "right", width: 280, panels: ["core.info", "x.old", "ext.a"] }] }),
      new Map([["x.old", "x.new"]]),
    );
    expect(out.rails[0].panels).toEqual(["core.info", "x.new", "ext.a"]);
  });

  it("drops the old id where the new panel is already placed, and an emptied rail with it", () => {
    const out = replacePanelIds(
      place({
        rails: [
          { id: "l", side: "left", width: 240, panels: ["x.new"] },
          { id: "r", side: "right", width: 280, panels: ["x.old"] },
        ],
      }),
      new Map([["x.old", "x.new"]]),
    );
    expect(out.rails).toEqual([{ id: "l", side: "left", width: 240, panels: ["x.new"] }]);
  });

  it("moves a floating window, its z-order and its collapsed flag", () => {
    const out = replacePanelIds(
      place({ floating: { "x.old": { x: 10, y: 20, width: 300 } }, zOrder: ["x.old"], collapsed: { "x.old": true } }),
      new Map([["x.old", "x.new"]]),
    );
    expect(out.floating).toEqual({ "x.new": { x: 10, y: 20, width: 300 } });
    expect(out.zOrder).toEqual(["x.new"]);
    expect(out.collapsed).toEqual({ "x.new": true });
  });

  it("drops a floating old window and its flag when the new panel is docked", () => {
    const out = replacePanelIds(
      place({
        rails: [{ id: "r", side: "right", width: 280, panels: ["x.new"] }],
        floating: { "x.old": { x: 1, y: 1, width: 300 } },
        zOrder: ["x.old"],
        collapsed: { "x.old": true },
      }),
      new Map([["x.old", "x.new"]]),
    );
    expect(out.floating).toEqual({});
    expect(out.zOrder).toEqual([]);
    expect(out.collapsed).toEqual({});
  });

  it("keeps the new panel's place in the z-order when a duplicate old window is dropped", () => {
    const out = replacePanelIds(
      place({
        floating: {
          "x.old": { x: 1, y: 1, width: 300 },
          other: { x: 2, y: 2, width: 300 },
          "x.new": { x: 3, y: 3, width: 300 },
        },
        zOrder: ["x.old", "other", "x.new"],
      }),
      new Map([["x.old", "x.new"]]),
    );
    expect(Object.keys(out.floating)).toEqual(["other", "x.new"]);
    expect(out.zOrder).toEqual(["other", "x.new"]);
  });

  it("lets the renamed old flag win over a stale flag on the new id, whatever the key order", () => {
    const rails = [{ id: "r", side: "right" as const, width: 280, panels: ["x.old"] }];
    const replacements = new Map([["x.old", "x.new"]]);
    for (const collapsed of [
      { "x.new": false, "x.old": true },
      { "x.old": true, "x.new": false },
    ]) {
      expect(replacePanelIds(place({ rails, collapsed }), replacements).collapsed).toEqual({ "x.new": true });
    }
  });

  it("gives two old ids for one new panel to the first reached, and drops the other's rail and flag", () => {
    const out = replacePanelIds(
      place({
        rails: [
          { id: "a", side: "left", width: 240, panels: ["x.old1"] },
          { id: "b", side: "right", width: 280, panels: ["core.info", "x.old2"] },
        ],
        collapsed: { "x.old1": true, "x.old2": false },
      }),
      new Map([
        ["x.old1", "x.new"],
        ["x.old2", "x.new"],
      ]),
    );
    expect(out.rails).toEqual([
      { id: "a", side: "left", width: 240, panels: ["x.new"] },
      { id: "b", side: "right", width: 280, panels: ["core.info"] },
    ]);
    expect(out.collapsed).toEqual({ "x.new": true });
  });

  it("gives two floating old ids for one new panel to the first reached, and drops the other's window", () => {
    const out = replacePanelIds(
      place({
        floating: { "x.old1": { x: 1, y: 1, width: 300 }, "x.old2": { x: 2, y: 2, width: 300 } },
        zOrder: ["x.old2", "x.old1"],
        collapsed: { "x.old1": true, "x.old2": false },
      }),
      new Map([
        ["x.old1", "x.new"],
        ["x.old2", "x.new"],
      ]),
    );
    expect(out.floating).toEqual({ "x.new": { x: 1, y: 1, width: 300 } });
    expect(out.zOrder).toEqual(["x.new"]);
    expect(out.collapsed).toEqual({ "x.new": true });
  });

  it("renames an old id in a rail and drops its floating window when it is in both", () => {
    const out = replacePanelIds(
      place({
        rails: [{ id: "r", side: "right", width: 280, panels: ["x.old"] }],
        floating: { "x.old": { x: 1, y: 1, width: 300 } },
        zOrder: ["x.old"],
        collapsed: { "x.old": true },
      }),
      new Map([["x.old", "x.new"]]),
    );
    expect(out.rails[0].panels).toEqual(["x.new"]);
    expect(out.floating).toEqual({});
    expect(out.zOrder).toEqual([]);
    expect(out.collapsed).toEqual({ "x.new": true });
  });

  it("returns the same object when nothing names a replaced id", () => {
    const p = place({ rails: [{ id: "r", side: "right", width: 280, panels: ["core.info"] }] });
    expect(replacePanelIds(p, new Map([["x.old", "x.new"]]))).toBe(p);
    expect(replacePanelIds(p, new Map())).toBe(p);
  });
});

describe("a panel that replaces an old one", () => {
  const savedWith = (panels: string[]) =>
    localStorage.setItem(
      LAYOUT_KEY,
      JSON.stringify({
        rails: [{ id: "right-1", side: "right", width: 280, panels }],
        floating: {},
        zOrder: [],
        collapsed: {},
      }),
    );

  it("takes the old panel's spot in a saved layout, and the layout is stored with it", () => {
    panel("core.info");
    panel("x.new", { replaces: ["x.old"] });
    savedWith(["x.old", "core.info"]);
    const { close } = boot();
    expect(rails()[0].panels).toEqual(["x.new", "core.info"]);
    expect(saved().rails[0].panels).toEqual(["x.new", "core.info"]);
    close();
  });

  it("swaps the live layout when it registers after the dock has loaded", async () => {
    panel("core.info");
    savedWith(["x.old", "core.info"]);
    const { close } = boot();
    expect(rails()[0].panels).toEqual(["x.old", "core.info"]);
    act(() => panel("x.new", { replaces: ["x.old"] }));
    expect(rails()[0].panels).toEqual(["x.new", "core.info"]);
    expect(useDockStore.getState().open).toContain("x.new");
    await flushSave();
    expect(saved().rails[0].panels).toEqual(["x.new", "core.info"]);
    close();
  });

  it("leaves the old panel alone while it is still registered", () => {
    panel("x.old");
    savedWith(["x.old"]);
    const { close } = boot();
    act(() => panel("x.new", { replaces: ["x.old"] }));
    expect(rails()[0].panels).toEqual(["x.old"]);
    close();
  });

  it("swaps in a layout preset without touching the saved Custom layout", async () => {
    savedWith(["core.info"]);
    registerLayout("test-ext", {
      id: "test.preset",
      name: "Preset",
      modules: { develop: { rails: [{ side: "right", panels: ["x.old"] }] } },
    });
    panel("core.info");
    panel("x.new", { replaces: ["x.old"] });
    const { close } = boot();
    await act(() => applyDockLayout("test.preset"));
    expect(rails()[0].panels).toEqual(["x.new"]);
    await flushSave();
    expect(saved().rails[0].panels).toEqual(["core.info"]);
    close();
  });

  it("swaps a preset's live layout on late registration without saving it as Custom", async () => {
    savedWith(["core.info"]);
    registerLayout("test-ext", {
      id: "test.preset",
      name: "Preset",
      modules: { develop: { rails: [{ side: "right", panels: ["x.old"] }] } },
    });
    panel("core.info");
    const { close } = boot();
    await act(() => applyDockLayout("test.preset"));
    act(() => panel("x.new", { replaces: ["x.old"] }));
    expect(rails()[0].panels).toEqual(["x.new"]);
    await flushSave();
    expect(saved().rails[0].panels).toEqual(["core.info"]);
    close();
  });

  it("stores the swapped layout once, not on every launch", () => {
    panel("core.info");
    panel("x.new", { replaces: ["x.old"] });
    savedWith(["x.old", "core.info"]);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    try {
      const writes = () => setItem.mock.calls.filter(([key]) => key === LAYOUT_KEY).length;
      let session = boot();
      expect(writes()).toBe(1);
      session.close();
      session = boot();
      expect(writes()).toBe(1);
      session.close();
    } finally {
      setItem.mockRestore();
    }
  });

  it("does not rewrite the stored layout of a module that is not loaded when a user layout is saved", () => {
    panel("core.info");
    panel("x.new", { replaces: ["x.old"] });
    savedWith(["x.old", "core.info"]);
    const before = localStorage.getItem(LAYOUT_KEY);
    const { close } = boot("map");
    const id = addUserLayout("Mine");
    expect(localStorage.getItem(LAYOUT_KEY)).toBe(before);
    expect(useUserLayouts.getState().layouts[id].modules.develop?.rails[0].panels).toEqual(["x.new", "core.info"]);
    close();
  });

  it("takes the old panel's spot in a user layout without rewriting the layout", async () => {
    panel("x.new", { replaces: ["x.old"] });
    useUserLayouts.setState({
      layouts: {
        mine: {
          id: "mine",
          name: "Mine",
          modules: { develop: { rails: [{ side: "right", panels: ["x.old"] }] } },
        },
      },
    });
    const { close } = boot();
    await act(() => applyDockLayout("mine"));
    expect(rails()[0].panels).toEqual(["x.new"]);
    expect(useUserLayouts.getState().layouts.mine.modules.develop?.rails[0].panels).toEqual(["x.old"]);
    close();
  });

  describe("in a bottom rail", () => {
    const savedBottom = () =>
      localStorage.setItem(
        LAYOUT_KEY,
        JSON.stringify({
          rails: [
            { id: "right-1", side: "right", width: 280, panels: ["core.info"] },
            { id: "bottom-1", side: "bottom", width: 280, height: 112, panels: ["x.old"] },
          ],
          floating: {},
          zOrder: [],
          collapsed: {},
        }),
      );
    const sides = () => rails().map((r) => r.side);

    it("drops a replacement that cannot dock there, as the load swaps it", () => {
      panel("core.info");
      panel("x.new", { replaces: ["x.old"] });
      savedBottom();
      const { close } = boot();
      expect(sides()).toEqual(["right"]);
      close();
    });

    it("drops a replacement that cannot dock there, as a late registration swaps it", () => {
      panel("core.info");
      savedBottom();
      const { close } = boot();
      expect(sides()).toEqual(["right", "bottom"]);
      act(() => panel("x.new", { replaces: ["x.old"] }));
      expect(sides()).toEqual(["right"]);
      close();
    });

    it("keeps a replacement that opts in to bottom docking, as the load swaps it", () => {
      panel("core.info");
      panel("x.new", { replaces: ["x.old"], allowBottomDock: true });
      savedBottom();
      const { close } = boot();
      expect(rails().map((r) => [r.side, r.panels])).toEqual([
        ["right", ["core.info"]],
        ["bottom", ["x.new"]],
      ]);
      close();
    });

    it("keeps a replacement that opts in to bottom docking, as a late registration swaps it", () => {
      panel("core.info");
      savedBottom();
      const { close } = boot();
      act(() => panel("x.new", { replaces: ["x.old"], allowBottomDock: true }));
      expect(rails().map((r) => [r.side, r.panels])).toEqual([
        ["right", ["core.info"]],
        ["bottom", ["x.new"]],
      ]);
      close();
    });
  });

  describe("when a layout is picked before the debounced save has run", () => {
    const registerPreset = () =>
      registerLayout("test-ext", {
        id: "test.preset",
        name: "Preset",
        modules: { develop: { rails: [{ side: "right", panels: ["x.preset"] }] } },
      });

    it("stores a live swap in the Custom layout, not the preset's", async () => {
      panel("core.info");
      savedWith(["x.old", "core.info"]);
      registerPreset();
      const { close } = boot();
      act(() => panel("x.new", { replaces: ["x.old"] }));
      await act(() => applyDockLayout("test.preset"));
      expect(rails()[0].panels).toEqual(["x.preset"]);
      await flushSave();
      expect(saved().rails[0].panels).toEqual(["x.new", "core.info"]);
      close();
    });

    it("stores a dock edit in the Custom layout, not the preset's", async () => {
      panel("core.info");
      panel("x.keep");
      savedWith(["core.info", "x.keep"]);
      registerPreset();
      const { close } = boot();
      act(() => toggleDockPanel("x.keep"));
      await act(() => applyDockLayout("test.preset"));
      await flushSave();
      expect(saved().rails[0].panels).toEqual(["core.info"]);
      close();
    });

    it("stores a dock edit in the Custom layout when another window picks the layout", async () => {
      panel("core.info");
      panel("x.keep");
      savedWith(["core.info", "x.keep"]);
      registerPreset();
      initDockLayouts();
      const { close } = boot();
      act(() => toggleDockPanel("x.keep"));
      act(() => {
        window.dispatchEvent(new StorageEvent("storage", { key: "sl_layout_pref", newValue: "test.preset" }));
      });
      expect(rails()[0].panels).toEqual(["x.preset"]);
      await flushSave();
      expect(saved().rails[0].panels).toEqual(["core.info"]);
      close();
    });

    const savedCollapsed = () =>
      localStorage.setItem(
        LAYOUT_KEY,
        JSON.stringify({
          rails: [{ id: "right-1", side: "right", width: 280, panels: ["core.info", "x.keep"] }],
          floating: {},
          zOrder: [],
          collapsed: { "core.info": true },
        }),
      );
    const editedCustom = {
      rails: [{ id: "right-1", side: "right", width: 280, panels: ["core.info"] }],
      floating: {},
      zOrder: [],
      collapsed: { "core.info": true },
    };

    it("stores a dock edit in the Custom layout when a user layout is saved from it", async () => {
      panel("core.info");
      panel("x.keep");
      savedCollapsed();
      let session = boot();
      act(() => toggleDockPanel("x.keep"));
      act(() => {
        addUserLayout("Mine");
      });
      // The saved layout loads on the next launch of the module; the Custom layout stays as edited.
      session.close();
      session = boot();
      await flushSave();
      expect(saved()).toEqual(editedCustom);
      session.close();
    });

    it("stores a dock edit in the Custom layout when a user layout is updated from it", async () => {
      panel("core.info");
      panel("x.keep");
      savedCollapsed();
      let session = boot();
      let id = "";
      act(() => {
        id = addUserLayout("Mine");
      });
      act(() => toggleDockPanel("x.keep"));
      act(() => updateUserLayout(id));
      session.close();
      session = boot();
      await flushSave();
      expect(saved()).toEqual(editedCustom);
      session.close();
    });

    it("drops a pending edit when the module is initialised again, rather than writing the reloaded layout", async () => {
      panel("core.info");
      panel("x.keep");
      const raw = JSON.stringify({
        rails: [{ id: "right-1", side: "right", width: 280, panels: ["core.info", "x.keep"] }],
      });
      localStorage.setItem(LAYOUT_KEY, raw);
      let session = boot();
      act(() => toggleDockPanel("x.keep"));
      session.close();
      session = boot();
      await flushSave();
      expect(localStorage.getItem(LAYOUT_KEY)).toBe(raw);
      session.close();
    });
  });
});
