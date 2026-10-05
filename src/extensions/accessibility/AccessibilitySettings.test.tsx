// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Preferences ▸ Accessibility offers the interface scale as the same − / +
// control as Preferences ▸ Interface and the welcome setup.

import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { updateSettings, useSettings } from "@/state/settings-store";
import { AccessibilitySettings } from "./AccessibilitySettings";

beforeEach(() => {
  localStorage.clear();
  updateSettings({ uiScale: 1 });
});

describe("AccessibilitySettings", () => {
  it("sets the interface scale with − and + instead of a slider", async () => {
    const user = userEvent.setup();
    render(<AccessibilitySettings />);
    expect(screen.queryByRole("slider", { name: /Interface scale/ })).toBeNull();
    const group = screen.getByRole("group", { name: "Interface scale" });
    await user.click(
      within(group).getByRole("button", { name: "Decrease interface scale" }),
    );
    expect(useSettings.getState().uiScale).toBe(0.9);
  });

  it("still says where else the control lives", () => {
    render(<AccessibilitySettings />);
    expect(screen.getByText(/The same control lives under Interface/)).toBeTruthy();
  });
});
