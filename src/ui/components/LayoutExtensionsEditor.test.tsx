// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The Extensions list under a saved layout: its switch, search, All and None
// over what the search shows, and why some extensions can't be ticked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ExtensionManifest } from "@/extensions/types";
import { noteExtensionRunning, noteRendersPixels } from "@/extensions/extension-kinds";
import { useDisabledExtensions } from "@/extensions/loader";
import { CUSTOM_LAYOUT, useLayoutStore, useUserLayouts } from "@/extensions/dock";
import { LayoutExtensionsEditor } from "./LayoutExtensionsEditor";

const LAYOUT = "user.test";

const manifest = (id: string, name: string): ExtensionManifest => ({
  id,
  name,
  version: "1.0.0",
  main: "index.js",
  repository: `acme/${id.split(".")[1]}`,
});

function saveLayout(switches: boolean, extensions?: Record<string, boolean>): void {
  useUserLayouts.setState({
    layouts: {
      [LAYOUT]: {
        id: LAYOUT,
        name: "Test",
        modules: {},
        switchesExtensions: switches,
        ...(extensions && { extensions }),
      },
    },
  });
}

const ticks = () => useUserLayouts.getState().layouts[LAYOUT].extensions;
const checkbox = (name: string) =>
  screen.queryByRole<HTMLInputElement>("checkbox", { name });

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("safelightNative", {
    plugins: {
      list: async () => [
        manifest("acme.map", "Map"),
        manifest("acme.pins", "Map Pins"),
        manifest("acme.speed", "Speed Edit"),
        manifest("acme.film", "Film Stocks"),
      ],
    },
  });
  for (const id of ["acme.map", "acme.pins", "acme.speed", "acme.film"])
    noteExtensionRunning(id);
  noteRendersPixels("acme.film");
  useDisabledExtensions.setState({ ids: ["acme.speed"] });
  useLayoutStore.setState({ activeId: CUSTOM_LAYOUT });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("a layout's Extensions list", () => {
  it("shows only its switch while the layout doesn't switch extensions", async () => {
    const user = userEvent.setup();
    saveLayout(false);
    render(<LayoutExtensionsEditor layoutId={LAYOUT} />);
    expect(screen.queryByRole("checkbox")).toBeNull();

    await user.click(
      screen.getByRole("switch", { name: "Switch extensions with this layout" }),
    );

    expect(useUserLayouts.getState().layouts[LAYOUT].switchesExtensions).toBe(true);
    expect((await screen.findByRole<HTMLInputElement>("checkbox", { name: "Map" })).checked).toBe(true);
    expect(checkbox("Speed Edit")?.checked).toBe(false);
  });

  it("hides the checklist when the switch is turned off, keeping the ticks", async () => {
    const user = userEvent.setup();
    saveLayout(true, { "acme.map": false });
    render(<LayoutExtensionsEditor layoutId={LAYOUT} />);
    await screen.findByRole("checkbox", { name: "Map" });

    await user.click(
      screen.getByRole("switch", { name: "Switch extensions with this layout" }),
    );

    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByText("Picking this layout leaves extensions as they are.")).toBeTruthy();
    expect(ticks()).toEqual({ "acme.map": false });
  });

  it("lists what a layout can't switch apart, saying why", async () => {
    saveLayout(true, {});
    render(<LayoutExtensionsEditor layoutId={LAYOUT} />);
    const held = await screen.findByRole("group", { name: "Not switched by layouts" });

    // The group shows the built-in panels before the installed list loads.
    expect(await within(held).findByText("Film Stocks")).toBeTruthy();
    expect(within(held).getByText("Changes how photos look")).toBeTruthy();
    expect(within(held).getByText("Accessibility")).toBeTruthy();
    expect(checkbox("Film Stocks")).toBeNull();
  });

  it("unticks an extension", async () => {
    const user = userEvent.setup();
    saveLayout(true, { "acme.map": true });
    render(<LayoutExtensionsEditor layoutId={LAYOUT} />);

    await user.click(await screen.findByRole("checkbox", { name: "Map" }));

    expect(ticks()).toEqual({ "acme.map": false });
    expect(checkbox("Map")?.checked).toBe(false);
  });

  it("ticks and unticks only what the search shows, in one change", async () => {
    const user = userEvent.setup();
    saveLayout(true, { "acme.map": true, "acme.pins": true, "acme.speed": true });
    render(<LayoutExtensionsEditor layoutId={LAYOUT} />);
    await screen.findByRole("checkbox", { name: "Map" });
    await user.type(screen.getByRole("searchbox", { name: "Search extensions" }), "map");
    expect(checkbox("Speed Edit")).toBeNull();
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    await user.click(screen.getByRole("button", { name: "None" }));

    expect(setItem.mock.calls.filter(([key]) => key === "sl_user_layouts")).toHaveLength(1);
    expect(ticks()).toEqual({ "acme.map": false, "acme.pins": false, "acme.speed": true });
    await user.click(screen.getByRole("button", { name: "All" }));
    expect(ticks()).toEqual({ "acme.map": true, "acme.pins": true, "acme.speed": true });
  });
});
