// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Preferences ▸ Shortcuts: two actions on the same keys, core or extension,
// are both marked and named against each other, so the person can see which
// one to rebind.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { shortcutsSection } from "./Shortcuts";
import { setExtensionName } from "@/extensions/param-registry";
import {
  registerExtensionAction,
  useExtensionActions,
  useKeybindings,
} from "@/state/keybindings-store";

const noop = () => {};
const field = (label: string) => screen.getByRole("button", { name: `Shortcut for ${label}` });
const renderSection = () => render(<>{shortcutsSection.render("")}</>);

beforeEach(() => {
  localStorage.clear();
  useKeybindings.setState({ overrides: {} });
  useExtensionActions.setState({ actions: new Map() });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  setExtensionName("acme.copies", "Virtual Copies");
  setExtensionName("acme.crop", "Crop & Straighten");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function registerClash(): void {
  act(() => {
    registerExtensionAction("acme.copies", { id: "acme.copies.create", label: "Create virtual copy", defaultCombo: "Ctrl+'", handler: noop });
    registerExtensionAction("acme.crop", { id: "acme.crop.grid", label: "Show grid", defaultCombo: "Ctrl+'", handler: noop });
  });
}

describe("Shortcuts", () => {
  it("marks two extensions on the same keys, each naming the other and its extension", () => {
    registerClash();
    renderSection();
    expect(field("Show grid").title).toMatch(/Create virtual copy \(Virtual Copies\)/);
    expect(field("Create virtual copy").title).toMatch(/Show grid \(Crop & Straighten\)/);
  });

  it("marks Safelight's own row when an extension takes its keys", () => {
    act(() =>
      registerExtensionAction("acme.crop", { id: "acme.crop.grid", label: "Show grid", defaultCombo: "Ctrl+B", handler: noop }),
    );
    renderSection();
    expect(field("Toggle colour assessment").title).toMatch(/Show grid \(Crop & Straighten\)/);
    expect(field("Show grid").title).toMatch(/Toggle colour assessment/);
  });

  it("picks up a clash from an extension that loads while it is open", () => {
    renderSection();
    expect(field("Toggle colour assessment").title).toBe("");
    act(() =>
      registerExtensionAction("acme.crop", { id: "acme.crop.grid", label: "Show grid", defaultCombo: "Ctrl+B", handler: noop }),
    );
    expect(field("Toggle colour assessment").title).toMatch(/Show grid/);
  });

  it("clears both marks once one of them is rebound", () => {
    registerClash();
    renderSection();
    fireEvent.click(field("Show grid"));
    fireEvent.keyDown(window, { key: "o", code: "KeyO", ctrlKey: true, altKey: true });
    expect(field("Show grid").title).toBe("");
    expect(field("Create virtual copy").title).toBe("");
  });

  it("leaves rows without a clash unmarked", () => {
    renderSection();
    expect(field("Toggle colour assessment").title).toBe("");
  });
});
