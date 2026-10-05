// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Step 2 of the welcome setup: how Safelight behaves while editing. Each
// switch writes Preferences' own setting and carries a description for
// assistive tech.

import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { updateSettings, useSettings } from "@/state/settings-store";
import { resetSetupForTests, useSetupStore } from "./setup-store";
import { WorkspaceStep } from "./WorkspaceStep";

beforeEach(() => {
  localStorage.clear();
  resetSetupForTests();
  updateSettings({
    canvasSurroundOverride: true,
    canvasSurround: "#777777",
    sliderJumpToCursor: false,
    basicDetailSliders: false,
    singleKeyShortcuts: true,
    restoreLastProject: false,
  });
});

const renderWorkspace = () => render(<WorkspaceStep headingId="setup-heading" />);
const toggle = (name: string) => screen.getByRole("switch", { name });
const shades = () =>
  within(screen.getByRole("group", { name: "Canvas surround shade" })).getAllByRole(
    "button",
  ) as HTMLButtonElement[];

describe("WorkspaceStep", () => {
  it("names the step with a heading that can take focus", () => {
    renderWorkspace();
    const heading = screen.getByRole("heading", { name: "Your workspace, your rules" });
    expect(heading.id).toBe("setup-heading");
    expect(heading.getAttribute("tabindex")).toBe("-1");
  });

  it("groups the settings", () => {
    renderWorkspace();
    expect(screen.getByRole("group", { name: "Develop" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Shortcuts and startup" })).toBeTruthy();
  });

  it("turns the canvas surround off and disables its shades", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    expect(toggle("Canvas surround").getAttribute("aria-checked")).toBe("true");
    expect(shades().some((b) => b.disabled)).toBe(false);
    await user.click(toggle("Canvas surround"));
    expect(useSettings.getState().canvasSurroundOverride).toBe(false);
    expect(shades().every((b) => b.disabled)).toBe(true);
  });

  it("picks a surround shade", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await user.click(screen.getByRole("button", { name: "White" }));
    expect(useSettings.getState().canvasSurround).toBe("#ffffff");
  });

  it.each([
    ["Sliders jump to cursor", "sliderJumpToCursor", true],
    ["Highlight & shadow detail sliders", "basicDetailSliders", true],
    ["Single-key shortcuts", "singleKeyShortcuts", false],
    ["Restore last project on launch", "restoreLastProject", true],
  ] as const)("flips %s", async (label, key, after) => {
    const user = userEvent.setup();
    renderWorkspace();
    await user.click(toggle(label));
    expect(useSettings.getState()[key]).toBe(after);
  });

  it("says F is fullscreen, not a module switch", () => {
    renderWorkspace();
    expect(
      screen.getByText(
        "Bare letters work as shortcuts: G for Library, D for Develop, F for fullscreen. Turn this off if they get in your way.",
      ),
    ).toBeTruthy();
  });

  it("describes every switch to assistive tech", () => {
    renderWorkspace();
    for (const sw of screen.getAllByRole("switch")) {
      const id = sw.getAttribute("aria-describedby");
      expect(id).toBeTruthy();
      expect(document.getElementById(id ?? "")?.textContent).toBeTruthy();
    }
  });

  it("goes back to Look and on to Extensions", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(useSetupStore.getState().step).toBe("look");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(useSetupStore.getState().step).toBe("extensions");
  });

  it("keeps its text at readable contrast", () => {
    const { container } = renderWorkspace();
    expect(container.querySelector(".text-text-muted")).toBeNull();
  });
});
