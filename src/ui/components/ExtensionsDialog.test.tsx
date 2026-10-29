// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The Extensions window maximizes into a full-window view and restores to the
// pop-up, and remembers which one it was across closes and restarts.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  closeExtensions,
  ExtensionsDialog,
  openExtensions,
} from "@/ui/components/ExtensionsDialog";
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  useSettings,
} from "@/state/settings-store";

const dialog = () => screen.getByRole("dialog", { name: "Extensions" });

const stored = () =>
  JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? "{}") as Record<string, unknown>;

beforeEach(() => {
  localStorage.clear();
  useSettings.setState({ ...DEFAULT_SETTINGS });
});

afterEach(() => act(closeExtensions));

describe("ExtensionsDialog maximize", () => {
  it("opens as the pop-up by default", () => {
    render(<ExtensionsDialog />);
    act(openExtensions);
    expect(dialog().dataset.maximized).toBeUndefined();
    expect(screen.getByRole("button", { name: "Maximize" })).toBeTruthy();
  });

  it("maximizes, restores, and persists the choice", async () => {
    const user = userEvent.setup();
    render(<ExtensionsDialog />);
    act(openExtensions);

    await user.click(screen.getByRole("button", { name: "Maximize" }));
    expect(dialog().dataset.maximized).toBe("true");
    expect(stored().extensionsMaximized).toBe(true);

    await user.click(screen.getByRole("button", { name: "Restore" }));
    expect(dialog().dataset.maximized).toBeUndefined();
    expect(stored().extensionsMaximized).toBe(false);
  });

  it("reopens maximized after being closed maximized", async () => {
    const user = userEvent.setup();
    render(<ExtensionsDialog />);
    act(openExtensions);
    await user.click(screen.getByRole("button", { name: "Maximize" }));

    act(closeExtensions);
    act(openExtensions);
    expect(dialog().dataset.maximized).toBe("true");
  });

  it("lays the store out expanded only while maximized", async () => {
    const user = userEvent.setup();
    render(<ExtensionsDialog />);
    act(openExtensions);
    expect(dialog().querySelector("[data-store-expanded]")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Maximize" }));
    expect(dialog().querySelector("[data-store-expanded]")).not.toBeNull();
  });
});
