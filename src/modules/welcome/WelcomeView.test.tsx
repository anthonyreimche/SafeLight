// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The welcome setup opens by itself on a fresh install and reruns from
// Preferences, so the recent-projects grid doesn't offer it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const recents = vi.hoisted(() => ({
  list: [] as { id: string; name: string; path: string | null; handle: null; openedAt: number; cover: Blob | null }[],
  hold: null as Promise<void> | null,
  remove: vi.fn(async (_id: string): Promise<void> => {}),
}));
vi.mock("@/project/recent", () => ({
  listRecentProjects: async () => {
    await recents.hold;
    return recents.list;
  },
  removeRecentProject: recents.remove,
}));

import { WelcomeView } from "./WelcomeView";
import { resetSetupForTests } from "./setup/setup-store";

beforeEach(() => {
  localStorage.clear();
  resetSetupForTests();
  recents.list = [];
  recents.hold = null;
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

  describe("while the recents are read", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("shows skeleton cards only once the wait lasts", async () => {
      recents.hold = new Promise<void>(() => {});
      render(<WelcomeView />);
      expect(document.querySelector(".sl-breathe")).toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      expect(document.querySelectorAll(".sl-breathe").length).toBeGreaterThan(1);
    });

    it("drops the skeletons when the cards arrive", async () => {
      let release!: () => void;
      recents.hold = new Promise<void>((resolve) => (release = resolve));
      recents.list = [{ id: "/p/rome", name: "Rome", path: "/p/rome", handle: null, openedAt: Date.now(), cover: null }];
      render(<WelcomeView />);
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      await act(async () => release());
      expect(screen.getByText("Rome")).toBeTruthy();
      expect(document.querySelector(".sl-breathe")).toBeNull();
    });
  });

  describe("when the cards arrive", () => {
    const original = Element.prototype.animate;
    afterEach(() => {
      Element.prototype.animate = original;
      document.documentElement.classList.remove("sl-reduce-motion");
    });

    beforeEach(() => {
      recents.list = [0, 1, 2].map((i) => ({
        id: "/p/" + i, name: "P" + i, path: "/p/" + i, handle: null, openedAt: Date.now(), cover: null,
      }));
    });

    it("cascades in with a stagger", async () => {
      const animate = vi.fn(() => ({ cancel: vi.fn() }));
      Element.prototype.animate = animate as unknown as typeof Element.prototype.animate;
      render(<WelcomeView />);
      await screen.findByText("P2");
      expect(animate).toHaveBeenCalledTimes(3);
      const delays = (animate.mock.calls as unknown as [unknown, { delay: number }][]).map((c) => c[1].delay);
      expect(delays).toEqual([0, 35, 70]);
    });

    it("holds still under Reduce motion", async () => {
      const animate = vi.fn(() => ({ cancel: vi.fn() }));
      Element.prototype.animate = animate as unknown as typeof Element.prototype.animate;
      document.documentElement.classList.add("sl-reduce-motion");
      render(<WelcomeView />);
      await screen.findByText("P2");
      expect(animate).not.toHaveBeenCalled();
    });

    it("copes with no animate in the environment", async () => {
      // @ts-expect-error jsdom lacks it; the guard must not throw
      Element.prototype.animate = undefined;
      render(<WelcomeView />);
      expect(await screen.findByText("P2")).toBeTruthy();
    });
  });

  it("fades a cover in once it has loaded", async () => {
    recents.list = [
      { id: "/p/rome", name: "Rome", path: "/p/rome", handle: null, openedAt: Date.now(), cover: new Blob(["x"]) },
    ];
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:cover", revokeObjectURL: () => {} }));
    render(<WelcomeView />);
    await screen.findByText("Rome");
    const img = document.querySelector("img") as HTMLImageElement;
    expect(img.style.opacity).toBe("0");
    expect(img.style.transition).toContain("150ms");
    fireEvent.load(img);
    expect(img.style.opacity).toBe("1");
  });
});
