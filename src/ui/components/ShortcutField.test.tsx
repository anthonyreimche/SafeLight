// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The control that records a shortcut for one action, as Preferences ▸
// Shortcuts lists them and extensions show them (api.components.ShortcutField).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ShortcutField } from "./ShortcutField";
import {
  getBinding,
  registerExtensionAction,
  setBinding,
  shortcutsSuspended,
  useExtensionActions,
  useKeybindings,
} from "@/state/keybindings-store";

const ID = "acme.layouts.workspace.a";

beforeEach(() => {
  localStorage.clear();
  useKeybindings.setState({ overrides: {} });
  useExtensionActions.setState({ actions: new Map() });
  registerExtensionAction("acme.layouts", { id: ID, label: "Switch to Culling", defaultCombo: "", handler: () => {} });
});

afterEach(cleanup);

const field = () => screen.getByRole("button", { name: /shortcut/i });

describe("ShortcutField", () => {
  it("reads None for an action with no shortcut", () => {
    render(<ShortcutField actionId={ID} />);
    expect(field().textContent).toBe("None");
  });

  it("records the next keys pressed after a click", () => {
    render(<ShortcutField actionId={ID} />);
    fireEvent.click(field());
    expect(field().textContent).toBe("Press keys…");
    fireEvent.keyDown(window, { key: "1", code: "Digit1", ctrlKey: true, altKey: true });
    expect(getBinding(ID)).toBe("Ctrl+Alt+1");
    expect(field().textContent).toBe("Ctrl+Alt+1");
  });

  it("holds the app's shortcuts while it records, and lets go after", () => {
    render(<ShortcutField actionId={ID} />);
    fireEvent.click(field());
    expect(shortcutsSuspended()).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(shortcutsSuspended()).toBe(false);
  });

  it("cancels on Escape, keeping the shortcut it had", () => {
    setBinding(ID, "Ctrl+Alt+2");
    render(<ShortcutField actionId={ID} />);
    fireEvent.click(field());
    fireEvent.keyDown(window, { key: "Escape" });
    expect(getBinding(ID)).toBe("Ctrl+Alt+2");
  });

  it("waits past a bare modifier", () => {
    render(<ShortcutField actionId={ID} />);
    fireEvent.click(field());
    fireEvent.keyDown(window, { key: "Control", code: "ControlLeft", ctrlKey: true });
    expect(field().textContent).toBe("Press keys…");
  });

  it("puts back the default with ↺", () => {
    setBinding(ID, "Ctrl+Alt+2");
    render(<ShortcutField actionId={ID} />);
    fireEvent.click(screen.getByRole("button", { name: /reset/i }));
    expect(getBinding(ID)).toBe("");
    expect(screen.queryByRole("button", { name: /reset/i })).toBeNull();
  });

  it("marks a shortcut another action also uses", () => {
    setBinding(ID, "Ctrl+Z");
    render(<ShortcutField actionId={ID} />);
    expect(field().getAttribute("title")).toMatch(/conflicts/i);
  });

  it("stops recording when the person clicks elsewhere", () => {
    render(
      <>
        <ShortcutField actionId={ID} />
        <p>elsewhere</p>
      </>,
    );
    fireEvent.click(field());
    fireEvent.pointerDown(screen.getByText("elsewhere"));
    expect(field().textContent).toBe("None");
    expect(shortcutsSuspended()).toBe(false);
  });
});
