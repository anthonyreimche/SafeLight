// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A dock panel's header: a click folds the panel, Alt+click opens it and folds
// the rest of its rail, the title works from the keyboard too, and the close
// button is a full-size target set apart from the fold area.

import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DockHost, useDockStore } from "../dock";
import { registerPanel, useRegistry } from "../registry";
import { registerEssentialModules } from "@/test/essential-modules.test-support";
import { DEFAULT_SETTINGS, useSettings } from "@/state/settings-store";

const Body = () => <div>body</div>;

beforeEach(() => {
  localStorage.clear();
  useRegistry.setState({ panels: {}, modules: {}, layouts: {} });
  registerEssentialModules();
  useSettings.setState({ ...DEFAULT_SETTINGS });
  useDockStore.setState({
    module: null,
    rails: [],
    floating: {},
    zOrder: [],
    collapsed: {},
    hidden: { left: false, right: false, bottom: false, floating: false },
    open: [],
    drag: null,
    target: null,
  });
});

function mount() {
  for (const title of ["A", "B", "C"]) {
    registerPanel("t", {
      id: `t.${title}`,
      title,
      component: Body,
      defaultDock: { module: "develop", direction: "left" },
    });
  }
  render(<DockHost module="develop">{null}</DockHost>);
}

const title = (name: string) => screen.getByRole("button", { name });
const collapsed = () => useDockStore.getState().collapsed;

describe("dock panel header", () => {
  it("folds the panel on a click", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(title("A"));
    expect(collapsed()["t.A"]).toBe(true);
    expect(title("A").getAttribute("aria-expanded")).toBe("false");
  });

  it("opens the panel and folds the rest of its rail on Alt+click", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(title("A"));
    await user.keyboard("{Alt>}");
    await user.click(title("A"));
    await user.keyboard("{/Alt}");
    expect(collapsed()).toMatchObject({ "t.A": false, "t.B": true, "t.C": true });
  });

  it("folds from the keyboard with Enter or Space, and solos with Alt+Enter", async () => {
    const user = userEvent.setup();
    mount();
    title("B").focus();
    await user.keyboard("{Enter}");
    expect(collapsed()["t.B"]).toBe(true);
    await user.keyboard(" ");
    expect(collapsed()["t.B"]).toBe(false);
    await user.keyboard("{Alt>}{Enter}{/Alt}");
    expect(collapsed()).toMatchObject({ "t.A": true, "t.B": false, "t.C": true });
  });

  it("names its gestures in a tooltip", () => {
    mount();
    expect(title("A").getAttribute("title")).toMatch(/Alt\+click/);
  });

  it("gives the close button a full-size target set apart from the title", () => {
    mount();
    const close = screen.getByRole("button", { name: "Close A panel" });
    expect(close.className).toMatch(/\bh-5\b/);
    expect(close.className).toMatch(/\bw-5\b/);
    expect(close.className).toMatch(/\bml-1\b/);
  });
});
