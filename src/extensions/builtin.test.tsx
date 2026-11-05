// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Library and Develop with the built-ins core still ships: the panels that left
// for their own extensions are gone from the registry and the default rails,
// and a saved layout that still names one boots with its placeholder.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DockHost, useDockStore } from "./dock";
import { loadBuiltins } from "./loader";
import { unregisterExtension, useRegistry } from "./registry";
import { BUILTIN_EXTENSIONS } from "./builtin";

const railPanels = () => useDockStore.getState().rails.flatMap((r) => r.panels);

beforeEach(() => {
  localStorage.clear();
  loadBuiltins();
});

afterEach(() => {
  for (const b of BUILTIN_EXTENSIONS) unregisterExtension(b.id);
  localStorage.clear();
});

describe("the built-ins core still ships", () => {
  it("register no panel: every one left core", () => {
    expect(Object.keys(useRegistry.getState().panels)).toEqual([]);
  });

  it("leave Library's rails empty by default", () => {
    render(<DockHost module="library">{<p>grid</p>}</DockHost>);
    expect(screen.getByText("grid")).toBeTruthy();
    expect(railPanels()).toEqual([]);
  });

  it("leave Develop's rails empty by default", () => {
    render(<DockHost module="develop">{null}</DockHost>);
    expect(railPanels()).toEqual([]);
  });

  it("boot a saved layout that names a panel that left with its placeholder", () => {
    localStorage.setItem(
      "sl_dock_layout_v4:library",
      JSON.stringify({ rails: [{ id: "left-1", side: "left", width: 240, panels: ["core.folders"] }] }),
    );
    render(<DockHost module="library">{null}</DockHost>);
    expect(screen.getByText("Panel “core.folders” is disabled or not installed.")).toBeTruthy();
  });
});
