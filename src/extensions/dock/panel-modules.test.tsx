// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A panel's `modules` list (#309): the modules it may be docked in. Without
// one a panel goes anywhere, as before.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  DockHost,
  applyDockLayout,
  toggleDockPanel,
  toggleDockPanelFloating,
  useDockStore,
  useUserLayouts,
  CUSTOM_LAYOUT,
} from "../dock";
import { registerLayout, registerModule, registerPanel, useRegistry } from "../registry";
import { registerEssentialModules } from "@/test/essential-modules.test-support";
import { ViewMenu } from "@/ui/components/ViewMenu";
import { DEFAULT_SETTINGS, useSettings } from "@/state/settings-store";

const Empty = () => null;

function panel(id: string, extra: object = {}) {
  registerPanel("test-ext", { id, title: id, component: Empty, ...extra });
}

function boot(module: string) {
  const view = render(<DockHost module={module}>{null}</DockHost>);
  return { close: () => view.unmount() };
}

const open = () => useDockStore.getState().open;

beforeEach(() => {
  localStorage.clear();
  useRegistry.setState({ panels: {}, modules: {}, layouts: {} });
  registerEssentialModules();
  registerModule("test-ext", { id: "print", label: "Print", component: Empty });
  useUserLayouts.setState({ layouts: {} });
  useSettings.setState({ ...DEFAULT_SETTINGS });
  useDockStore.setState({
    module: null,
    rails: [],
    floating: {},
    zOrder: [],
    collapsed: {},
    hidden: { left: false, right: false, bottom: false, floating: false },
    open: [],
    drag: null,
    target: null,
  });
  applyDockLayout(CUSTOM_LAYOUT);
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("opening a panel", () => {
  it("opens a panel without modules in any module", () => {
    panel("x.any");
    const { close } = boot("library");
    act(() => toggleDockPanel("x.any"));
    expect(open()).toEqual(["x.any"]);
    close();
  });

  it("opens a panel in a module it lists", () => {
    panel("print.settings", { modules: ["print"] });
    const { close } = boot("print");
    act(() => toggleDockPanel("print.settings"));
    expect(open()).toEqual(["print.settings"]);
    close();
  });

  it("refuses togglePanel in a module it does not list", () => {
    panel("print.settings", { modules: ["print"] });
    const { close } = boot("library");
    act(() => toggleDockPanel("print.settings"));
    act(() => toggleDockPanel("print.settings", { direction: "right" }));
    expect(open()).toEqual([]);
    close();
  });

  it("refuses the View menu's floating open in a module it does not list", () => {
    panel("print.settings", { modules: ["print"] });
    const { close } = boot("develop");
    act(() => toggleDockPanelFloating("print.settings"));
    expect(open()).toEqual([]);
    close();
  });

  it("lists in the View menu only the panels the module allows", async () => {
    panel("x.any", { title: "Anywhere" });
    panel("print.settings", { title: "Print settings", modules: ["print"] });
    panel("crop", { title: "Crop", modules: ["develop"] });
    const { close } = boot("library");
    render(<ViewMenu />);
    await userEvent.click(screen.getByRole("button", { name: "View" }));
    expect(screen.queryByText("Anywhere")).not.toBeNull();
    expect(screen.queryByText("Print settings")).toBeNull();
    expect(screen.queryByText("Crop")).toBeNull();
    close();
  });
});

describe("layouts naming a panel in another module", () => {
  it("leaves it out of a saved layout's rails and floating windows", () => {
    panel("x.any");
    panel("print.settings", { modules: ["print"] });
    panel("print.preview", { modules: ["print"] });
    localStorage.setItem(
      "sl_dock_layout_v4:library",
      JSON.stringify({
        rails: [
          { id: "r1", side: "right", width: 280, panels: ["x.any", "print.settings"] },
          { id: "r2", side: "left", width: 280, panels: ["print.preview"] },
        ],
        floating: { "print.preview": { x: 10, y: 10, width: 300 } },
        zOrder: ["print.preview"],
        collapsed: {},
      }),
    );
    const { close } = boot("library");
    const s = useDockStore.getState();
    expect(s.rails).toEqual([{ id: "r1", side: "right", width: 280, panels: ["x.any"] }]);
    expect(s.floating).toEqual({});
    expect(s.zOrder).toEqual([]);
    expect(s.open).toEqual(["x.any"]);
    close();
  });

  it("leaves it out of a registered preset", async () => {
    panel("x.any");
    panel("crop", { modules: ["develop"] });
    registerLayout("test-ext", {
      id: "test.preset",
      name: "Preset",
      modules: { library: { rails: [{ side: "left", panels: ["crop", "x.any"] }] } },
    });
    const { close } = boot("library");
    await act(() => applyDockLayout("test.preset"));
    expect(open()).toEqual(["x.any"]);
    close();
  });

  it("keeps it in a module it lists", () => {
    panel("crop", { modules: ["develop", "library"] });
    localStorage.setItem(
      "sl_dock_layout_v4:library",
      JSON.stringify({ rails: [{ id: "r1", side: "left", width: 280, panels: ["crop"] }] }),
    );
    const { close } = boot("library");
    expect(open()).toEqual(["crop"]);
    close();
  });

  it("drops it from the live dock when it registers after the layout loaded", () => {
    localStorage.setItem(
      "sl_dock_layout_v4:develop",
      JSON.stringify({
        rails: [{ id: "r1", side: "right", width: 280, panels: ["x.any", "print.settings"] }],
        floating: { "print.float": { x: 0, y: 0, width: 300 } },
        zOrder: ["print.float"],
      }),
    );
    panel("x.any");
    const { close } = boot("develop");
    expect(open()).toEqual(["x.any", "print.settings", "print.float"]);
    act(() => {
      panel("print.settings", { modules: ["print"] });
      panel("print.float", { modules: ["print"] });
    });
    expect(open()).toEqual(["x.any"]);
    expect(useDockStore.getState().zOrder).toEqual([]);
    close();
  });
});

describe("registering modules", () => {
  it("ignores a modules value that isn't a list, with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    panel("x.bad", { modules: "print" });
    expect(useRegistry.getState().panels["x.bad"].modules).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('panel "x.bad" modules'));
  });

  it("drops entries that aren't module ids, with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    panel("x.mixed", { modules: ["print", 3, null] });
    expect(useRegistry.getState().panels["x.mixed"].modules).toEqual(["print"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('panel "x.mixed" modules'));
  });

  it("ignores an empty list, with a warning, so the panel isn't shut out of every module", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    panel("x.none", { modules: [] });
    expect(useRegistry.getState().panels["x.none"].modules).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('panel "x.none" modules'));
  });
});
