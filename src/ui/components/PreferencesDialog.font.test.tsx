// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Preferences ▸ Interface font: Afacad is the default ("" keeps the built-in
// stack) and JetBrains Mono stays one click away.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { openPreferences, PreferencesDialog } from "./PreferencesDialog";
import { MONO_FONT_STACK, resetSettings, useSettings } from "@/state/settings-store";

class SilentChannel {
  postMessage(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("BroadcastChannel", SilentChannel);
  resetSettings();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const showInterface = () => {
  render(<PreferencesDialog />);
  act(() => openPreferences("Interface"));
};

describe("Preferences ▸ Interface font", () => {
  it("marks Afacad as the default while no font is chosen", () => {
    showInterface();
    expect(screen.getByRole("button", { name: "Afacad (default)" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("offers JetBrains Mono as a preset that writes the mono stack", async () => {
    const user = userEvent.setup();
    showInterface();
    await user.click(screen.getByRole("button", { name: "JetBrains Mono" }));
    expect(useSettings.getState().uiFont).toBe(MONO_FONT_STACK);
    expect(screen.getByRole("button", { name: "JetBrains Mono" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("goes back to the default preset", async () => {
    const user = userEvent.setup();
    showInterface();
    await user.click(screen.getByRole("button", { name: "JetBrains Mono" }));
    await user.click(screen.getByRole("button", { name: "Afacad (default)" }));
    expect(useSettings.getState().uiFont).toBe("");
  });
});
