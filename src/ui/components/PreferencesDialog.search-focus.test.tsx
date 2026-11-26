// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Preferences opens with its search box focused, so typing searches at once.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DEFAULT_SETTINGS, useSettings } from "@/state/settings-store";
import { closePreferences, openPreferences, PreferencesDialog } from "./PreferencesDialog";

class SilentChannel {
  postMessage(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

const search = () => screen.getByRole("textbox", { name: "Search settings" });

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("BroadcastChannel", SilentChannel);
  useSettings.setState({ ...DEFAULT_SETTINGS });
});

afterEach(() => {
  act(closePreferences);
  vi.unstubAllGlobals();
});

describe("PreferencesDialog search focus", () => {
  it("focuses the search box when it opens", () => {
    render(<PreferencesDialog />);
    act(() => openPreferences());
    expect(document.activeElement).toBe(search());
  });

  it("takes typing straight into the search", async () => {
    const user = userEvent.setup();
    render(<PreferencesDialog />);
    act(() => openPreferences());
    await user.keyboard("scale");
    expect((search() as HTMLInputElement).value).toBe("scale");
  });

  it("focuses the search box again on a later open", () => {
    render(<PreferencesDialog />);
    act(() => openPreferences());
    act(closePreferences);
    act(() => openPreferences());
    expect(document.activeElement).toBe(search());
  });
});
