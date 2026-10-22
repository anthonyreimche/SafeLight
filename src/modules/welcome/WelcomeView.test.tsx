// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The welcome setup opens by itself on a fresh install and reruns from
// Preferences, so the recent-projects grid doesn't offer it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { WelcomeView } from "./WelcomeView";
import { resetSetupForTests } from "./setup/setup-store";

beforeEach(() => {
  localStorage.clear();
  resetSetupForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WelcomeView", () => {
  it("offers no welcome setup button in the desktop app", () => {
    vi.stubGlobal("safelightNative", {
      plugins: { list: async () => [], kits: async () => null },
    });
    render(<WelcomeView />);
    expect(screen.queryByRole("button", { name: "Welcome setup" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open Folder…" })).toBeTruthy();
  });

  it("offers Report an issue, since the welcome screen has no top bar", () => {
    render(<WelcomeView />);
    expect(screen.getByRole("button", { name: "Report an issue" })).toBeTruthy();
  });
});
