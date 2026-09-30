// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ModuleTabs } from "./ModuleTabs";
import { useUIStore } from "@/state/ui-store";
import { registerModule, useRegistry } from "@/extensions/registry";

const View = () => null;

/** The tab buttons in strip order (the pop-out buttons carry aria-labels). */
const tabLabels = () =>
  screen
    .getAllByRole("button")
    .filter((b) => !b.hasAttribute("aria-label"))
    .map((b) => b.textContent);

beforeEach(() => {
  useRegistry.setState({ modules: {} });
  useUIStore.setState({ activeModule: "library", detached: new Set() });
  vi.stubGlobal("open", vi.fn(() => ({ closed: false, focus: vi.fn(), close: vi.fn() })));
});

describe("ModuleTabs", () => {
  it("lists the built-ins, then registered modules, each with a pop-out control", () => {
    registerModule("ext", { id: "map", label: "Map", component: View });
    render(<ModuleTabs />);
    expect(tabLabels()).toEqual(["Library", "Develop", "Map"]);
    expect(screen.getByRole("button", { name: "Map: open in a new window" })).toBeTruthy();
  });

  it("activates a registered module on click", () => {
    registerModule("ext", { id: "map", label: "Map", component: View });
    render(<ModuleTabs />);
    fireEvent.click(screen.getByRole("button", { name: "Map" }));
    expect(useUIStore.getState().activeModule).toBe("map");
  });

  it("shows a popped-out module as detached and offers to re-attach it", () => {
    registerModule("ext", { id: "map", label: "Map", component: View });
    useUIStore.setState({ detached: new Set(["map"]) });
    render(<ModuleTabs />);
    expect(screen.getByRole("button", { name: "Map" }).getAttribute("title")).toBe("Open in its window");
    expect(screen.getByRole("button", { name: "Map: re-attach to this window" })).toBeTruthy();
  });

  it("follows the registry when a module is added after mount", () => {
    render(<ModuleTabs />);
    expect(tabLabels()).toEqual(["Library", "Develop"]);
    // registerModule mutates the registry store directly (no fireEvent to wrap
    // it), so the re-render has to be flushed explicitly before asserting.
    act(() => {
      registerModule("ext", { id: "map", label: "Map", component: View });
    });
    expect(tabLabels()).toEqual(["Library", "Develop", "Map"]);
  });
});
