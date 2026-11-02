// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The welcome setup opens by itself on a fresh install and reruns from
// Preferences, so the recent-projects grid doesn't offer it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const recents = vi.hoisted(() => ({
  list: [] as { id: string; name: string; path: string | null; handle: null; openedAt: number; cover: null }[],
  remove: vi.fn(async (_id: string): Promise<void> => {}),
}));
vi.mock("@/project/recent", () => ({
  listRecentProjects: async () => recents.list,
  removeRecentProject: recents.remove,
}));

import { WelcomeView } from "./WelcomeView";
import { resetSetupForTests } from "./setup/setup-store";

beforeEach(() => {
  localStorage.clear();
  resetSetupForTests();
  recents.list = [];
  recents.remove.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WelcomeView", () => {
  it("offers no welcome setup button in the desktop app", () => {
    vi.stubGlobal("safelightNative", {
      plugins: { list: async () => [], kits: async () => null },
    });
    render(<WelcomeView />);
    expect(screen.queryByRole("button", { name: "Welcome setup" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open Folder…" })).toBeTruthy();
  });

  it("offers Report an issue, since the welcome screen has no top bar", () => {
    render(<WelcomeView />);
    expect(screen.getByRole("button", { name: "Report an issue" })).toBeTruthy();
  });

  describe("a recent project's remove button", () => {
    beforeEach(() => {
      recents.list = [{ id: "/p/rome", name: "Rome", path: "/p/rome", handle: null, openedAt: Date.now(), cover: null }];
    });

    it("is a real button beside the card, not inside it, and keyboard reachable", async () => {
      render(<WelcomeView />);
      const remove = await screen.findByRole("button", { name: "Remove Rome from recents" });

      expect(remove.parentElement?.closest("button")).toBeNull();
      expect(remove.tabIndex).toBe(0);
      expect(remove.className).toContain("focus-visible:opacity-100");
    });

    it("removes the project from the list", async () => {
      render(<WelcomeView />);
      fireEvent.click(await screen.findByRole("button", { name: "Remove Rome from recents" }));

      await waitFor(() => expect(screen.queryByText("Rome")).toBeNull());
      expect(recents.remove).toHaveBeenCalledWith("/p/rome");
    });
  });
});
