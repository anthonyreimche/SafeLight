// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Layouts reach the dock from extensions (registerLayout) and from storage any
// extension can write. Both are plain JS at runtime, so a malformed one must
// resolve to something usable instead of throwing inside initModule on every
// launch.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { applyDockLayout, initModule, CUSTOM_LAYOUT, useUserLayouts } from "./layouts";
import { useDockStore } from "./store";
import { registerLayout, registerPanel, useRegistry } from "../registry";
import { registerEssentialModules } from "@/test/essential-modules.test-support";
import type { ModuleLayoutDef } from "../types";

const LAYOUT_KEY = "sl_dock_layout_v4:develop";

const Empty = () => null;

/** A layout as an extension might hand it over, whatever its type says. */
function untyped(json: string): ModuleLayoutDef {
  return JSON.parse(json);
}

function panel(id: string, direction: "left" | "right" = "right") {
  registerPanel("test-ext", {
    id,
    title: id,
    component: Empty,
    defaultDock: { module: "develop", direction },
  });
}

function preset(develop: ModuleLayoutDef) {
  registerLayout("test-ext", { id: "test.preset", name: "Preset", modules: { develop } });
  applyDockLayout("test.preset");
}

const railPanels = () => useDockStore.getState().rails.map((r) => [r.side, r.panels]);

beforeEach(() => {
  localStorage.clear();
  useRegistry.setState({ panels: {}, modules: {}, layouts: {} });
  registerEssentialModules();
  useUserLayouts.setState({ layouts: {} });
  useDockStore.setState({ module: null, rails: [], floating: {}, zOrder: [], collapsed: {}, open: [] });
  applyDockLayout(CUSTOM_LAYOUT);
  panel("x.a");
  panel("x.b", "left");
});

afterEach(() => {
  localStorage.clear();
});

describe("a registered layout that isn't the shape its type promises", () => {
  it("falls back to the seeded defaults when the module's rails aren't a list", () => {
    preset(untyped("{}"));
    expect(() => initModule("develop")).not.toThrow();
    expect(railPanels()).toEqual([
      ["left", ["x.b"]],
      ["right", ["x.a"]],
    ]);
  });

  it("drops rails without a panels list or a known side and keeps the good ones", () => {
    preset(
      untyped(
        JSON.stringify({
          rails: [
            { side: "right", panels: "x" },
            { side: "top", panels: ["x.b"] },
            { side: "left", width: "wide", panels: ["x.a", 7] },
          ],
          floating: "x",
        }),
      ),
    );
    expect(() => initModule("develop")).not.toThrow();
    const { rails, floating } = useDockStore.getState();
    expect(railPanels()).toEqual([["left", ["x.a"]]]);
    expect(rails[0].width).toBe(280);
    expect(floating).toEqual({});
  });

  it("resolves a well-formed layout as before", () => {
    preset({ rails: [{ side: "right", width: 300, panels: ["x.a", "x.b"] }] });
    initModule("develop");
    expect(useDockStore.getState().rails).toEqual([
      { id: "develop-right-0", side: "right", width: 300, panels: ["x.a", "x.b"] },
    ]);
  });
});

describe("a saved Custom layout that isn't the shape the dock writes", () => {
  it("falls back to the seeded defaults and drops the bad fields", () => {
    localStorage.setItem(
      LAYOUT_KEY,
      JSON.stringify({ rails: [{}], floating: "x", zOrder: 5, collapsed: [1] }),
    );
    expect(() => initModule("develop")).not.toThrow();
    const { floating, zOrder, collapsed } = useDockStore.getState();
    expect(railPanels()).toEqual([
      ["left", ["x.b"]],
      ["right", ["x.a"]],
    ]);
    expect(floating).toEqual({});
    expect(zOrder).toEqual([]);
    expect(collapsed).toEqual({});
  });

  it("keeps the valid rails and derives the stacking from the floating panels", () => {
    localStorage.setItem(
      LAYOUT_KEY,
      JSON.stringify({
        rails: [{ id: "r1", side: "right", width: 260, panels: ["x.a"] }, { side: "right" }],
        floating: { "x.b": { x: 10, y: 20, width: 240 } },
        zOrder: ["x.b", 3],
        collapsed: "x.a",
      }),
    );
    expect(() => initModule("develop")).not.toThrow();
    const { rails, zOrder, collapsed } = useDockStore.getState();
    expect(rails).toEqual([{ id: "r1", side: "right", width: 260, panels: ["x.a"] }]);
    expect(zOrder).toEqual(["x.b"]);
    expect(collapsed).toEqual({});
  });

  it("keeps a saved layout with every panel closed empty", () => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ rails: [], floating: {}, zOrder: [], collapsed: {} }));
    initModule("develop");
    expect(useDockStore.getState().rails).toEqual([]);
  });
});
