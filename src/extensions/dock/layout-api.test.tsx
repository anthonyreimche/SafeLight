// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What api.layouts gives a layout manager extension: the current module's
// arrangement, whether the dock still shows one, showing one, saved layouts,
// and which layout an edit turned into Custom.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  addUserLayout,
  applyDockLayout,
  captureModuleLayout,
  CUSTOM_LAYOUT,
  initModule,
  moduleShowsLayout,
  saveUserLayout,
  setLayoutExtensions,
  setLayoutSwitchesExtensions,
  showModuleLayout,
  useLayoutStore,
  useUserLayouts,
} from "./layouts";
import { setRailWidth, toggleDockPanel } from "./actions";
import { useDockStore } from "./store";
import { registerLayout, registerPanel, unregisterPanel, useRegistry } from "../registry";
import { registerEssentialModules } from "@/test/essential-modules.test-support";
import type { ModuleLayoutDef } from "../types";

const Empty = () => null;

function panel(id: string, extra: { replaces?: string[] } = {}) {
  registerPanel("test-ext", {
    id,
    title: id,
    component: Empty,
    defaultDock: { module: "develop", direction: "right" },
    ...extra,
  });
}

const raw: ModuleLayoutDef = { rails: [{ side: "right", width: 320, panels: ["x.a", "x.b"] }] };
const minimal: ModuleLayoutDef = { rails: [{ side: "left", width: 260, panels: ["x.a"] }] };
const railPanels = () => useDockStore.getState().rails.map((r) => [r.side, r.panels]);

beforeEach(() => {
  localStorage.clear();
  useRegistry.setState({ panels: {}, modules: {}, layouts: {} });
  registerEssentialModules();
  useUserLayouts.setState({ layouts: {} });
  useDockStore.setState({ module: null, rails: [], floating: {}, zOrder: [], collapsed: {}, open: [] });
  applyDockLayout(CUSTOM_LAYOUT);
  panel("x.a");
  panel("x.b");
  initModule("develop");
});

afterEach(() => localStorage.clear());

describe("captureModuleLayout", () => {
  it("is the current module's arrangement", () => {
    showModuleLayout(raw);
    expect(captureModuleLayout()).toEqual(raw);
  });

  it("is another module's arrangement as this window would load it", () => {
    showModuleLayout(minimal);
    initModule("library");
    expect(captureModuleLayout("develop")).toEqual(minimal);
  });

  it("is null for a module that isn't registered", () => {
    expect(captureModuleLayout("nope")).toBeNull();
  });

  it("is null before the dock has a module", () => {
    useDockStore.setState({ module: null });
    expect(captureModuleLayout()).toBeNull();
  });
});

describe("moduleShowsLayout", () => {
  it("is true right after the layout is shown", () => {
    showModuleLayout(raw);
    expect(moduleShowsLayout(raw)).toBe(true);
  });

  it("is false once the dock is edited", () => {
    showModuleLayout(raw);
    toggleDockPanel("x.b");
    expect(moduleShowsLayout(raw)).toBe(false);
  });

  it("ignores a width that moved by less than a pixel", () => {
    showModuleLayout(raw);
    setRailWidth(useDockStore.getState().rails[0].id, 320.4);
    expect(moduleShowsLayout(raw)).toBe(true);
  });

  it("sees a rail resized by more than a pixel", () => {
    showModuleLayout(raw);
    setRailWidth(useDockStore.getState().rails[0].id, 340);
    expect(moduleShowsLayout(raw)).toBe(false);
  });

  it("reads a layout naming a replaced panel as the dock shows it", () => {
    unregisterPanel("test-ext", "x.b");
    panel("x.c", { replaces: ["x.b"] });
    showModuleLayout(raw);
    expect(railPanels()).toEqual([["right", ["x.a", "x.c"]]]);
    expect(moduleShowsLayout(raw)).toBe(true);
  });

  it("treats the collapsed list as a set of the panels shown", () => {
    showModuleLayout({ ...raw, collapsed: ["x.b", "x.a", "x.gone"] });
    expect(moduleShowsLayout({ ...raw, collapsed: ["x.a", "x.b"] })).toBe(true);
  });
});

describe("showModuleLayout", () => {
  it("under Custom, shows the layout and keeps it as Custom's", () => {
    showModuleLayout(minimal);
    expect(railPanels()).toEqual([["left", ["x.a"]]]);
    expect(useLayoutStore.getState().activeId).toBe(CUSTOM_LAYOUT);
    initModule("library");
    initModule("develop");
    expect(railPanels()).toEqual([["left", ["x.a"]]]);
  });

  it("under a saved layout, writes into it and keeps it picked", () => {
    const id = addUserLayout("Culling");
    showModuleLayout(minimal);
    expect(useLayoutStore.getState().activeId).toBe(id);
    expect(useUserLayouts.getState().layouts[id].modules.develop).toEqual(minimal);
    expect(railPanels()).toEqual([["left", ["x.a"]]]);
  });

  it("under a registered preset, turns it into Custom showing the layout", () => {
    registerLayout("test-ext", { id: "test.preset", name: "Preset", modules: { develop: raw } });
    applyDockLayout("test.preset");
    showModuleLayout(minimal);
    expect(useLayoutStore.getState().activeId).toBe(CUSTOM_LAYOUT);
    expect(railPanels()).toEqual([["left", ["x.a"]]]);
  });

  it("drops an edit still waiting to be saved, so it can't land over the layout", async () => {
    showModuleLayout(raw);
    setRailWidth(useDockStore.getState().rails[0].id, 400);
    showModuleLayout(minimal);
    await new Promise((r) => setTimeout(r, 400));
    initModule("library");
    initModule("develop");
    expect(railPanels()).toEqual([["left", ["x.a"]]]);
  });
});

describe("editedFrom", () => {
  it("names the saved layout a dock edit turned into Custom", () => {
    const id = addUserLayout("Culling");
    toggleDockPanel("x.b");
    expect(useLayoutStore.getState()).toMatchObject({ activeId: CUSTOM_LAYOUT, editedFrom: id });
  });

  it("is cleared when a layout is picked", () => {
    const id = addUserLayout("Culling");
    toggleDockPanel("x.b");
    applyDockLayout(id);
    expect(useLayoutStore.getState().editedFrom).toBeUndefined();
  });

  it("is cleared when Custom is picked", () => {
    addUserLayout("Culling");
    toggleDockPanel("x.b");
    applyDockLayout(CUSTOM_LAYOUT);
    expect(useLayoutStore.getState().editedFrom).toBeUndefined();
  });

  it("stays through further edits under Custom", () => {
    const id = addUserLayout("Culling");
    toggleDockPanel("x.b");
    toggleDockPanel("x.b");
    expect(useLayoutStore.getState().editedFrom).toBe(id);
  });
});

describe("saveUserLayout", () => {
  it("creates a saved layout and returns its id", () => {
    const id = saveUserLayout({ name: " RAW editing ", modules: { develop: raw } });
    expect(useUserLayouts.getState().layouts[id]).toMatchObject({ id, name: "RAW editing", modules: { develop: raw } });
  });

  it("replaces the name and arrangements of one, keeping its extension ticks", async () => {
    const id = addUserLayout("Culling");
    setLayoutSwitchesExtensions(id, true);
    await setLayoutExtensions(id, { "x.ext": false });
    saveUserLayout({ id, name: "Cull", modules: { develop: minimal } });
    const saved = useUserLayouts.getState().layouts[id];
    expect(saved).toMatchObject({ name: "Cull", switchesExtensions: true, extensions: { "x.ext": false } });
    expect(saved.modules).toEqual({ develop: minimal });
  });

  it("never takes extension ticks from the caller", () => {
    const sneaky = { name: "S", modules: {}, switchesExtensions: true, extensions: { "x.ext": false } };
    const id = saveUserLayout(sneaky);
    expect(useUserLayouts.getState().layouts[id].switchesExtensions).toBeUndefined();
    expect(useUserLayouts.getState().layouts[id].extensions).toBeUndefined();
  });

  it("leaves out an arrangement that isn't one", () => {
    const id = saveUserLayout({ name: "S", modules: { develop: raw, library: JSON.parse('{"rails": 3}') } });
    expect(useUserLayouts.getState().layouts[id].modules).toEqual({ develop: raw });
  });

  it("refuses an id that isn't a saved layout's", () => {
    expect(() => saveUserLayout({ id: "user.nope", name: "S", modules: {} })).toThrow(/no saved layout/);
  });
});
