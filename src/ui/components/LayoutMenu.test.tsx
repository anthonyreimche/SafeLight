// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Sections extensions add to the Layout menu (registerLayoutMenu).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LayoutMenu } from "./LayoutMenu";
import { registerLayoutMenu, unregisterExtension, useRegistry } from "@/extensions/registry";
import { useUserLayouts } from "@/extensions/dock";

function Section({ close }: { close: () => void }) {
  return <button onClick={close}>Workspaces from the extension</button>;
}

beforeEach(() => {
  useRegistry.setState({ layoutMenus: {}, layouts: {} });
  useUserLayouts.setState({
    layouts: { "user.a": { id: "user.a", name: "Culling", modules: {} } },
  });
});

afterEach(() => {
  unregisterExtension("acme.layouts");
});

const open = () => userEvent.click(screen.getByRole("button", { name: /layout/i }));

describe("Layout menu sections", () => {
  it("draws an extension's section in the menu", async () => {
    registerLayoutMenu("acme.layouts", { id: "acme.layouts.menu", component: Section });
    render(<LayoutMenu />);
    await open();
    expect(screen.getByText("Workspaces from the extension")).toBeTruthy();
    expect(screen.getByText("Culling")).toBeTruthy();
  });

  it("closes the menu when the section calls close", async () => {
    registerLayoutMenu("acme.layouts", { id: "acme.layouts.menu", component: Section });
    render(<LayoutMenu />);
    await open();
    await userEvent.click(screen.getByText("Workspaces from the extension"));
    expect(screen.queryByText("Workspaces from the extension")).toBeNull();
  });

  it("closes the menu once a layout is picked", async () => {
    render(<LayoutMenu />);
    await open();
    await userEvent.click(screen.getByText("Culling"));
    expect(screen.queryByText("Culling")).toBeNull();
    expect(screen.getByRole("button", { name: /layout/i }).getAttribute("aria-expanded")).toBe("false");
  });

  it("leaves out the saved layouts and Manage layouts… for a section that replaces them", async () => {
    registerLayoutMenu("acme.layouts", { id: "acme.layouts.menu", component: Section, replacesSavedLayouts: true });
    render(<LayoutMenu />);
    await open();
    expect(screen.queryByText("Culling")).toBeNull();
    expect(screen.queryByText("Manage layouts…")).toBeNull();
    expect(screen.getByText("Custom")).toBeTruthy();
  });

  it("brings the saved layouts back when the extension stops", async () => {
    registerLayoutMenu("acme.layouts", { id: "acme.layouts.menu", component: Section, replacesSavedLayouts: true });
    unregisterExtension("acme.layouts");
    render(<LayoutMenu />);
    await open();
    expect(screen.getByText("Culling")).toBeTruthy();
    expect(screen.getByText("Manage layouts…")).toBeTruthy();
  });
});
