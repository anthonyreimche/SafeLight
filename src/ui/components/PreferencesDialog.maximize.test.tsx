// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The Preferences window maximizes to fill the app below the top bar and
// restores to the pop-up, and remembers which one it was across closes and
// restarts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  useSettings,
} from "@/state/settings-store";
import { closePreferences, openPreferences, PreferencesDialog } from "./PreferencesDialog";

class SilentChannel {
  postMessage(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

const dialog = () => screen.getByRole("dialog", { name: "Preferences" });

const stored = () =>
  JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? "{}") as Record<string, unknown>;

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("BroadcastChannel", SilentChannel);
  useSettings.setState({ ...DEFAULT_SETTINGS });
});

afterEach(() => {
  act(closePreferences);
  vi.unstubAllGlobals();
});

describe("PreferencesDialog maximize", () => {
  it("opens as the pop-up by default", () => {
    render(<PreferencesDialog />);
    act(() => openPreferences());
    expect(dialog().dataset.maximized).toBeUndefined();
    expect(screen.getByRole("button", { name: "Maximize" })).toBeTruthy();
  });

  it("maximizes, restores, and persists the choice", async () => {
    const user = userEvent.setup();
    render(<PreferencesDialog />);
    act(() => openPreferences());

    await user.click(screen.getByRole("button", { name: "Maximize" }));
    expect(dialog().dataset.maximized).toBe("true");
    expect(stored().preferencesMaximized).toBe(true);

    await user.click(screen.getByRole("button", { name: "Restore" }));
    expect(dialog().dataset.maximized).toBeUndefined();
    expect(stored().preferencesMaximized).toBe(false);
  });

  it("reopens maximized after being closed maximized", async () => {
    const user = userEvent.setup();
    render(<PreferencesDialog />);
    act(() => openPreferences());
    await user.click(screen.getByRole("button", { name: "Maximize" }));

    act(closePreferences);
    act(() => openPreferences());
    expect(dialog().dataset.maximized).toBe("true");
  });
});
