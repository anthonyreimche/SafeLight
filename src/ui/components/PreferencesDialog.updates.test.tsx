// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Preferences ▸ Updates offers an in-app install only where this copy can take
// the release's asset; everywhere else (macOS, AppImage, the browser build, a
// release without this platform's asset) it points at the release page.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { openPreferences, PreferencesDialog } from "./PreferencesDialog";
import { resetSettings } from "@/state/settings-store";
import type { NativeUpdatesBridge, UpdateSupport } from "@/extensions/types";

const mocks = vi.hoisted(() => ({ updates: null as NativeUpdatesBridge | null }));

vi.mock("@/native/privileged", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/native/privileged")>()),
  privilegedUpdates: () => mocks.updates,
}));

class SilentChannel {
  postMessage(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

const NEWER = (() => {
  const [major, minor, patch] = __APP_VERSION__.split(".").map(Number);
  return `${major}.${minor}.${patch + 1}`;
})();
const RELEASE_URL = `https://github.com/anthonyreimche/SafeLight/releases/tag/v${NEWER}`;

const desktop = (support: UpdateSupport) => {
  const bridge = {
    install: vi.fn((_repo: string, _tag: string) => Promise.resolve()),
    support: vi.fn((_names: string[]) => Promise.resolve(support)),
  };
  mocks.updates = bridge;
  return bridge;
};

beforeEach(() => {
  mocks.updates = null;
  localStorage.clear();
  resetSettings();
  vi.stubGlobal("BroadcastChannel", SilentChannel);
  vi.stubGlobal("open", vi.fn());
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => [
        {
          tag_name: `v${NEWER}`,
          html_url: RELEASE_URL,
          body: "Notes",
          draft: false,
          prerelease: false,
          assets: [{ name: `Safelight.Setup.${NEWER}.exe` }],
        },
      ],
    })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function showReleases() {
  const user = userEvent.setup();
  render(<PreferencesDialog />);
  act(() => openPreferences("Updates"));
  await user.click(screen.getByRole("button", { name: "Load releases" }));
  await screen.findByText(`v${NEWER}`);
  await act(async () => {});
  return user;
}

describe("Preferences ▸ Updates ▸ Release history", () => {
  it("offers the install where this copy can take the release's asset", async () => {
    const bridge = desktop("install");
    const user = await showReleases();

    expect(bridge.support).toHaveBeenCalledWith([`Safelight.Setup.${NEWER}.exe`]);
    expect(screen.getByRole("button", { name: "View release" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Download" }));
    expect(bridge.install).toHaveBeenCalledWith("anthonyreimche/SafeLight", `v${NEWER}`);
  });

  // A Linux package goes to the software installer and Safelight stays open.
  it("says where the package went once it has opened", async () => {
    desktop("install");
    const user = await showReleases();

    await user.click(screen.getByRole("button", { name: "Download" }));
    expect(await screen.findByText("Opened in your software installer")).toBeTruthy();
    expect(screen.queryByText("Downloading…")).toBeNull();
  });

  it.each([
    ["a copy that can't install itself", () => void desktop("release-page")],
    ["the browser build", () => {}],
  ])("sends %s to the release page", async (_label, setup) => {
    setup();
    const user = await showReleases();

    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
    expect(screen.queryByRole("button", { name: "View release" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Open release page" }));
    expect(window.open).toHaveBeenCalledWith(RELEASE_URL, "_blank", "noopener,noreferrer");
  });
});

describe("Preferences ▸ Updates ▸ Manual check", () => {
  it("sends a copy that can't install itself to the release page", async () => {
    desktop("release-page");
    const user = userEvent.setup();
    render(<PreferencesDialog />);
    act(() => openPreferences("Updates"));
    await user.click(screen.getByRole("button", { name: "Check now" }));
    await screen.findByText(`v${NEWER} is available`);
    await act(async () => {});

    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open release page" })).toBeTruthy();
  });
});
