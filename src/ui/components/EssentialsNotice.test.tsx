// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The top bar says so when some essentials failed to install on upgrade, and
// offers to try again or to open the Essentials kit in the Extensions window.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TopBar } from "./TopBar";
import { closeExtensions, ExtensionsDialog } from "./ExtensionsDialog";
import { MIGRATION_KEY, useEssentialsMigration } from "@/extensions/essentials-migration";
import { useExtStoreUI } from "@/extensions/store-ui";

const NOTICE = "Some essentials couldn't be installed.";

const failed = (missing: string[]) =>
  useEssentialsMigration.setState({ status: "failed", missing });

beforeEach(() => {
  localStorage.clear();
  useEssentialsMigration.setState({ status: "idle", missing: [] });
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  act(closeExtensions);
  useExtStoreUI.setState({ browse: "home", kit: null });
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

describe("essentials notice", () => {
  it("is hidden unless some essentials failed to install", () => {
    render(<TopBar />);
    expect(screen.queryByText(NOTICE)).toBeNull();
    act(() => useEssentialsMigration.setState({ status: "installing", missing: ["safelight.hsl"] }));
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it("shows in the top bar with Retry and Manage extensions once installing failed", () => {
    render(<TopBar />);
    act(() => failed(["safelight.hsl"]));
    expect(screen.getByRole("banner").textContent).toContain(NOTICE);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Manage extensions" })).toBeTruthy();
  });

  it("is not shown in a detached window", () => {
    window.history.replaceState({}, "", "/?detached=develop");
    failed(["safelight.hsl"]);
    render(<TopBar />);
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it("tries the missing essentials again on Retry", async () => {
    const user = userEvent.setup();
    const list = vi.fn(async () => [{ id: "safelight.hsl" }]);
    vi.stubGlobal("safelightNative", { plugins: { list } });
    failed(["safelight.hsl"]);
    render(<TopBar />);
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByText(NOTICE)).toBeNull());
    expect(list).toHaveBeenCalled();
    expect(useEssentialsMigration.getState()).toEqual({ status: "idle", missing: [] });
    expect(JSON.parse(localStorage.getItem(MIGRATION_KEY) ?? "null")).toEqual({
      done: ["safelight.hsl"],
    });
  });

  it("opens the Extensions window on the Essentials kit", async () => {
    const user = userEvent.setup();
    failed(["safelight.hsl"]);
    render(
      <>
        <TopBar />
        <ExtensionsDialog />
      </>,
    );
    await user.click(screen.getByRole("button", { name: "Manage extensions" }));
    expect(screen.getByRole("dialog", { name: "Extensions" })).toBeTruthy();
    expect(useExtStoreUI.getState().kit).toBe("essentials");
  });
});
