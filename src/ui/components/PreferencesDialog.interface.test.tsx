// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Preferences ▸ Interface uses the same scale buttons and shade swatches as
// the welcome setup, and the scale stays findable by search.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { updateSettings, useSettings } from "@/state/settings-store";
import { useUserLayouts } from "@/extensions/dock";
import { openPreferences, PreferencesDialog } from "./PreferencesDialog";

class SilentChannel {
  postMessage(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("BroadcastChannel", SilentChannel);
  updateSettings({
    uiScale: 1,
    canvasSurroundOverride: true,
    canvasSurround: "#777777",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const showInterface = () => {
  render(<PreferencesDialog />);
  act(() => openPreferences("Interface"));
};

describe("Preferences ▸ Interface", () => {
  it("sets the interface scale with − and + instead of a slider", async () => {
    const user = userEvent.setup();
    showInterface();
    expect(screen.queryByRole("slider", { name: /Interface scale/ })).toBeNull();
    const group = screen.getByRole("group", { name: "Interface scale" });
    await user.click(
      within(group).getByRole("button", { name: "Increase interface scale" }),
    );
    expect(useSettings.getState().uiScale).toBe(1.1);
  });

  it("picks a canvas surround shade from the shared swatches", async () => {
    const user = userEvent.setup();
    showInterface();
    const shades = screen.getByRole("group", { name: "Canvas surround shade" });
    await user.click(within(shades).getByRole("button", { name: "White" }));
    expect(useSettings.getState().canvasSurround).toBe("#ffffff");
  });

  it("still finds the interface scale through search", async () => {
    const user = userEvent.setup();
    showInterface();
    await user.type(
      screen.getByRole("textbox", { name: "Search settings" }),
      "interface scale",
    );
    expect(screen.getAllByRole("group", { name: "Interface scale" }).length).toBeGreaterThan(0);
  });

  it("turns saving collapsed panels to the layout off and on", async () => {
    const user = userEvent.setup();
    updateSettings({ autoSaveCollapsedPanels: true });
    showInterface();
    const toggle = screen.getByRole("switch", { name: /Save collapsed panels to the layout/ });
    await user.click(toggle);
    expect(useSettings.getState().autoSaveCollapsedPanels).toBe(false);
    await user.click(toggle);
    expect(useSettings.getState().autoSaveCollapsedPanels).toBe(true);
  });

  it("opens a saved layout's Extensions list under its row", async () => {
    const user = userEvent.setup();
    useUserLayouts.setState({
      layouts: { "user.a": { id: "user.a", name: "Culling", modules: {} } },
    });
    showInterface();
    const toggle = screen.getByRole("button", { name: "Extensions for Culling" });
    const extensionSwitch = () =>
      screen.queryByRole("switch", { name: "Switch extensions with this layout" });

    await user.click(toggle);
    expect(extensionSwitch()).not.toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    await user.click(toggle);
    expect(extensionSwitch()).toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });
});
