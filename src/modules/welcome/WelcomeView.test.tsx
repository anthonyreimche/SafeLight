// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The welcome grid is where people land after a skipped setup, so it offers
// the setup again (desktop app only: the browser build can't install).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WelcomeView } from "./WelcomeView";
import { resetSetupForTests, useSetupStore } from "./setup/setup-store";

beforeEach(() => {
  localStorage.clear();
  resetSetupForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WelcomeView", () => {
  it("opens the welcome setup as a rerun", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("safelightNative", {
      plugins: { list: async () => [], kits: async () => null },
    });
    render(<WelcomeView />);
    await user.click(screen.getByRole("button", { name: "Welcome setup" }));
    const s = useSetupStore.getState();
    expect([s.phase, s.mode, s.step]).toEqual(["open", "rerun", "look"]);
  });

  it("offers no setup without the desktop bridge", () => {
    render(<WelcomeView />);
    expect(screen.queryByRole("button", { name: "Welcome setup" })).toBeNull();
  });
});
