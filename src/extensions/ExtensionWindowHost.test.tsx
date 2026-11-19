// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// An extension's window opens over the app like the Extensions window: its
// title in the titlebar, Esc and the close button shut it, Maximize only when
// it asks for one, and a crash in its content stays inside it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ExtensionWindowHost } from "./ExtensionWindowHost";
import { makeScopedAPI } from "./host";
import { unregisterExtension, useRegistry } from "./registry";
import { useOpenWindow } from "./window-store";
import { popEscapeHandler } from "@/ui/escape-stack";

const Store = () => <p>Filters to install</p>;
const Tools = () => <p>Other tools</p>;
const Broken = () => {
  throw new Error("no filters");
};

const dialog = (name: string) => screen.queryByRole("dialog", { name });

beforeEach(() => {
  useRegistry.setState({ windows: {} });
  useOpenWindow.setState({ open: null, maximized: {} });
});

afterEach(() => {
  act(() => {
    unregisterExtension("acme");
    unregisterExtension("other");
  });
  vi.restoreAllMocks();
});

describe("ExtensionWindowHost", () => {
  it("shows nothing until a window is opened, then its title and content", () => {
    const api = makeScopedAPI("acme");
    api.registerWindow({ id: "acme.store", title: "Filter store", component: Store });
    render(<ExtensionWindowHost />);
    expect(screen.queryByRole("dialog")).toBeNull();

    act(() => api.windows.open("acme.store"));
    expect(dialog("Filter store")).not.toBeNull();
    expect(screen.getByText("Filters to install")).toBeTruthy();
  });

  it("closes on Esc", () => {
    const api = makeScopedAPI("acme");
    api.registerWindow({ id: "acme.store", title: "Filter store", component: Store });
    render(<ExtensionWindowHost />);
    act(() => api.windows.open("acme.store"));

    act(() => {
      popEscapeHandler();
    });
    expect(dialog("Filter store")).toBeNull();
    expect(api.windows.isOpen("acme.store")).toBe(false);
  });

  it("closes from the close button", async () => {
    const user = userEvent.setup();
    const api = makeScopedAPI("acme");
    api.registerWindow({ id: "acme.store", title: "Filter store", component: Store });
    render(<ExtensionWindowHost />);
    act(() => api.windows.open("acme.store"));

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(dialog("Filter store")).toBeNull();
    expect(api.windows.isOpen("acme.store")).toBe(false);
  });

  it("offers Maximize only when the window asks for it", async () => {
    const user = userEvent.setup();
    const api = makeScopedAPI("acme");
    api.registerWindow({ id: "acme.plain", title: "Plain", component: Store });
    api.registerWindow({ id: "acme.store", title: "Filter store", component: Store, maximizable: true });
    render(<ExtensionWindowHost />);

    act(() => api.windows.open("acme.plain"));
    expect(screen.queryByRole("button", { name: "Maximize" })).toBeNull();

    act(() => api.windows.open("acme.store"));
    await user.click(screen.getByRole("button", { name: "Maximize" }));
    expect(dialog("Filter store")?.dataset.maximized).toBe("true");

    act(() => api.windows.close("acme.store"));
    act(() => api.windows.open("acme.store"));
    expect(dialog("Filter store")?.dataset.maximized).toBe("true");
    await user.click(screen.getByRole("button", { name: "Restore" }));
    expect(dialog("Filter store")?.dataset.maximized).toBeUndefined();
  });

  it("shows a crash notice in the window when its content throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const api = makeScopedAPI("acme");
    api.registerWindow({ id: "acme.store", title: "Filter store", component: Broken });
    render(<ExtensionWindowHost />);

    act(() => api.windows.open("acme.store"));
    expect(dialog("Filter store")).not.toBeNull();
    expect(screen.getByText(/Window "acme\.store" crashed: no filters/)).toBeTruthy();
  });

  it("shows one extension window at a time", () => {
    const acme = makeScopedAPI("acme");
    const other = makeScopedAPI("other");
    acme.registerWindow({ id: "acme.store", title: "Filter store", component: Store });
    other.registerWindow({ id: "other.tools", title: "Tools", component: Tools });
    render(<ExtensionWindowHost />);

    act(() => acme.windows.open("acme.store"));
    act(() => other.windows.open("other.tools"));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(dialog("Tools")).not.toBeNull();
    expect(screen.queryByText("Filters to install")).toBeNull();
  });

  it("shows nothing and forgets the open window once it is unregistered", () => {
    const api = makeScopedAPI("acme");
    api.registerWindow({ id: "acme.store", title: "Filter store", component: Store });
    render(<ExtensionWindowHost />);
    act(() => api.windows.open("acme.store"));

    act(() => useRegistry.setState({ windows: {} }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useOpenWindow.getState().open).toBeNull();
  });
});
