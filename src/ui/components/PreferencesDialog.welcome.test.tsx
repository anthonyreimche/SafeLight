// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Preferences ▸ Interface offers the welcome setup again, in the main window
// of the desktop app only: the setup layer never renders in a detached window.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { openPreferences, PreferencesDialog } from "./PreferencesDialog";
import {
  resetSetupForTests,
  useSetupStore,
} from "@/modules/welcome/setup/setup-store";

class SilentChannel {
  postMessage(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

beforeEach(() => {
  localStorage.clear();
  resetSetupForTests();
  vi.stubGlobal("BroadcastChannel", SilentChannel);
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

const stubNative = () =>
  vi.stubGlobal("safelightNative", {
    plugins: { list: async () => [], kits: async () => null },
  });

const showInterface = () => {
  render(<PreferencesDialog />);
  act(() => openPreferences("Interface"));
};

describe("Preferences ▸ Welcome setup", () => {
  it("closes Preferences and opens the setup as a rerun", async () => {
    const user = userEvent.setup();
    stubNative();
    showInterface();
    await user.click(screen.getByRole("button", { name: "Run again" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    const s = useSetupStore.getState();
    expect([s.phase, s.mode, s.step]).toEqual(["open", "rerun", "look"]);
  });

  it("says the rerun covers the look, the workspace and the kits", () => {
    stubNative();
    showInterface();
    expect(
      screen.getByText(
        "Pick a look, workspace settings and starter kits again. Nothing installed is removed.",
      ),
    ).toBeTruthy();
  });

  it("isn't offered in a detached window", () => {
    stubNative();
    window.history.replaceState({}, "", "/?detached=develop");
    showInterface();
    expect(screen.queryByRole("button", { name: "Run again" })).toBeNull();
  });

  it("isn't offered without the desktop bridge", () => {
    showInterface();
    expect(screen.queryByRole("button", { name: "Run again" })).toBeNull();
  });
});
