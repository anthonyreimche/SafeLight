// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Step 1 of the welcome setup writes the same settings Preferences does, so a
// choice made here is the choice Preferences shows afterwards.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useDisabledExtensions } from "@/extensions/loader";
import { registerTheme, unregisterExtension } from "@/extensions/registry";
import { useThemeStore } from "@/extensions/themes";
import {
  UI_FONT_PRESETS,
  updateSettings,
  useSettings,
} from "@/state/settings-store";
import { LookStep } from "./LookStep";
import { resetSetupForTests, useSetupStore } from "./setup-store";

beforeEach(() => {
  localStorage.clear();
  resetSetupForTests();
  registerTheme("test", {
    id: "test.dusk",
    name: "Dusk",
    vars: { "--color-surface-0": "#111111" },
  });
  registerTheme("test", { id: "test.dawn", name: "Dawn", vars: {} });
  useThemeStore.setState({ activeId: "test.dusk" });
  useDisabledExtensions.setState({ ids: [] });
  updateSettings({
    uiScale: 1,
    uiFont: "",
    highContrast: false,
    largerText: false,
    largerControls: false,
    strongFocus: false,
    lowercaseHeadings: false,
    reduceTransparency: false,
    reduceMotion: false,
  });
});

afterEach(() => {
  unregisterExtension("test");
});

const renderLook = () => render(<LookStep headingId="setup-heading" />);
const group = (name: string) => screen.getByRole("group", { name });
const radio = (name: string) =>
  screen.getByRole("radio", { name }) as HTMLInputElement;
const preview = (name: string) =>
  radio(name).closest("label")?.querySelector<HTMLElement>("[aria-hidden='true']")
    ?.style.fontFamily ?? "";

describe("LookStep", () => {
  it("names the step with a heading that can take focus", () => {
    renderLook();
    const heading = screen.getByRole("heading", { name: "Pick a look" });
    expect(heading.id).toBe("setup-heading");
    expect(heading.getAttribute("tabindex")).toBe("-1");
  });

  it("lists every registered theme with the active one checked", () => {
    renderLook();
    const themes = within(group("Theme")).getAllByRole("radio");
    expect(themes.map((r) => r.getAttribute("value"))).toEqual([
      "test.dawn",
      "test.dusk",
    ]);
    expect(radio("Dusk").checked).toBe(true);
  });

  it("applies a theme the moment it's picked", async () => {
    const user = userEvent.setup();
    renderLook();
    await user.click(radio("Dawn"));
    expect(useThemeStore.getState().activeId).toBe("test.dawn");
    expect(localStorage.getItem("sl_theme")).toBe("test.dawn");
  });

  it("offers every interface font, the current one checked", () => {
    renderLook();
    const fonts = within(group("Interface font")).getAllByRole("radio");
    expect(fonts.map((r) => r.getAttribute("value"))).toEqual(
      UI_FONT_PRESETS.map((f) => f.value),
    );
    expect(radio("Afacad (default)").checked).toBe(true);
  });

  it("previews each font in itself, the default in the built-in stack", () => {
    renderLook();
    expect(preview("Serif")).toContain("Georgia");
    expect(preview("Afacad (default)")).toContain("Afacad");
  });

  it("applies an interface font the moment it's picked", async () => {
    const user = userEvent.setup();
    renderLook();
    await user.click(radio("Serif"));
    const serif = UI_FONT_PRESETS.find((f) => f.label === "Serif")?.value;
    expect(useSettings.getState().uiFont).toBe(serif);
    expect(radio("Serif").checked).toBe(true);
  });

  it("checks no font card for a custom font, and says where it lives", () => {
    updateSettings({ uiFont: '"Comic Sans MS", cursive' });
    renderLook();
    const fonts = within(group("Interface font")).getAllByRole(
      "radio",
    ) as HTMLInputElement[];
    expect(fonts.some((r) => r.checked)).toBe(false);
    expect(screen.getByText(/custom font from Preferences/)).toBeTruthy();
  });

  it("puts the scale control above the cards, so a missed + click hits text", () => {
    renderLook();
    const follows = (a: HTMLElement, b: HTMLElement) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(group("Interface scale"), group("Theme"))).toBe(true);
    expect(follows(group("Interface scale"), group("Interface font"))).toBe(true);
  });

  it("marks the picked theme card with a check, and no other", () => {
    renderLook();
    const card = (name: string) => radio(name).closest("label");
    expect(card("Dusk")?.textContent).toContain("✓");
    expect(card("Dawn")?.textContent).not.toContain("✓");
  });

  it("marks the picked font card with a check, and no other", () => {
    renderLook();
    const card = (name: string) => radio(name).closest("label");
    expect(card("Afacad (default)")?.textContent).toContain("✓");
    expect(card("Serif")?.textContent).not.toContain("✓");
  });

  it("sets the interface scale with − and + instead of a slider", async () => {
    const user = userEvent.setup();
    renderLook();
    expect(screen.queryByRole("slider")).toBeNull();
    await user.click(
      within(group("Interface scale")).getByRole("button", {
        name: "Increase interface scale",
      }),
    );
    expect(useSettings.getState().uiScale).toBe(1.1);
    expect(within(group("Interface scale")).getByText("110%")).toBeTruthy();
  });

  it.each([
    ["High contrast", "highContrast"],
    ["Larger text", "largerText"],
    ["Larger controls", "largerControls"],
    ["Strong focus indicator", "strongFocus"],
    ["Lowercase headings", "lowercaseHeadings"],
    ["Reduce transparency", "reduceTransparency"],
    ["Reduce motion", "reduceMotion"],
  ] as const)("turns on %s", async (label, key) => {
    const user = userEvent.setup();
    renderLook();
    await user.click(
      within(group("Accessibility")).getByRole("switch", { name: label }),
    );
    expect(useSettings.getState()[key]).toBe(true);
  });

  it("keeps only Reduce motion while the accessibility extension is off", () => {
    useDisabledExtensions.setState({ ids: ["core.accessibility"] });
    renderLook();
    const switches = within(group("Accessibility")).getAllByRole("switch");
    expect(switches.map((s) => s.textContent)).toEqual(["Reduce motion"]);
    expect(screen.queryByText(/Preferences ▸ Accessibility/)).toBeNull();
    expect(group("Interface scale")).toBeTruthy();
  });

  it("continues to the Workspace step", async () => {
    const user = userEvent.setup();
    renderLook();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(useSetupStore.getState().step).toBe("workspace");
  });

  it("keeps its text at readable contrast", () => {
    const { container } = renderLook();
    expect(container.querySelector(".text-text-muted")).toBeNull();
  });
});
