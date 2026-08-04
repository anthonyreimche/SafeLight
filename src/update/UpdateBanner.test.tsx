// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The banner is driven end to end through the real update checker with only
// GitHub's response stubbed, because "is this release actually newer" is the
// whole point of it — mocking checkForUpdate would test nothing. Versions are
// derived from the running build rather than hard-coded, so the file survives a
// version bump.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSettings } from "@/state/settings-store";
import { getDismissedVersion } from "./update-checker";
import { UpdateBanner } from "./UpdateBanner";

// Matches APP_UPDATE_POLL_MS in UpdateBanner.
const POLL_MS = 3 * 60 * 60 * 1000;

const CURRENT = __APP_VERSION__;
const NEWER = (() => {
  const [major, minor, patch] = CURRENT.split(".").map(Number);
  return `${major}.${minor}.${patch + 1}`;
})();

const release = (version: string, prerelease = false) => ({
  tag_name: `v${version}`,
  html_url: `https://github.com/anthonyreimche/SafeLight/releases/tag/v${version}`,
  body: "",
  draft: false,
  prerelease,
});

let fetchMock: ReturnType<typeof vi.fn>;

function serve(...releases: ReturnType<typeof release>[]) {
  fetchMock.mockResolvedValue({ ok: true, json: async () => releases });
}

/** Let the in-flight check settle, and run the clock forward when a test has
 *  faked it — user-event's own waits need the real clock, so only the polling
 *  tests switch over. */
const settle = (ms = 0) =>
  act(async () => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(ms);
    else await new Promise((resolve) => setTimeout(resolve, ms));
  });

async function mount() {
  const view = render(<UpdateBanner />);
  await settle();
  return view;
}

const banner = () => screen.queryByRole("status");

beforeEach(() => {
  localStorage.clear();
  useSettings.setState({ checkForUpdates: true, updateChannel: "stable" });
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  // jsdom refuses to navigate; the banner opens the release page through it.
  vi.stubGlobal("open", vi.fn());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("when it appears", () => {
  it("stays silent when the newest release is the build already running", async () => {
    serve(release(CURRENT));
    await mount();
    expect(banner()).toBeNull();
  });

  it("stays silent when GitHub can't be reached", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    await mount();
    expect(banner()).toBeNull();
  });

  it("announces a release that really is newer", async () => {
    serve(release(CURRENT), release(NEWER));
    await mount();
    expect(banner()?.textContent).toContain(`Safelight v${NEWER} is available.`);
  });

  it("holds back a pre-release on the stable channel", async () => {
    serve(release(CURRENT), release(NEWER, true));
    await mount();
    expect(banner()).toBeNull();
  });

  it("offers that same pre-release once the channel asks for everything", async () => {
    useSettings.setState({ updateChannel: "all" });
    serve(release(CURRENT), release(NEWER, true));
    await mount();
    expect(banner()?.textContent).toContain(`Safelight v${NEWER} is available.`);
  });

  it("never reaches the network while the preference is off", async () => {
    useSettings.setState({ checkForUpdates: false });
    serve(release(NEWER));
    await mount();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(banner()).toBeNull();
  });

  it("retires a banner already on screen when the preference is turned off", async () => {
    serve(release(NEWER));
    await mount();
    expect(banner()).not.toBeNull();

    act(() => useSettings.setState({ checkForUpdates: false }));
    expect(banner()).toBeNull();
  });
});

describe("dismissing", () => {
  it("remembers a skipped release across launches", async () => {
    const user = userEvent.setup();
    serve(release(NEWER));
    const { unmount } = await mount();

    await user.click(screen.getByRole("button", { name: "Skip this release" }));
    expect(banner()).toBeNull();
    expect(getDismissedVersion()).toBe(NEWER);

    unmount();
    await mount();
    expect(banner()).toBeNull();
  });

  it("forgets a merely closed release at the next launch", async () => {
    const user = userEvent.setup();
    serve(release(NEWER));
    const { unmount } = await mount();

    await user.click(screen.getByRole("button", { name: "Close update notification" }));
    expect(banner()).toBeNull();
    expect(getDismissedVersion()).toBeNull();

    // Suppressed for the rest of this session, through any later re-check…
    act(() => useSettings.setState({ updateChannel: "all" }));
    await settle();
    expect(banner()).toBeNull();

    // …and offered again on the next launch.
    unmount();
    await mount();
    expect(banner()).not.toBeNull();
  });
});

describe("polling", () => {
  it("picks up a release published while the app was left open", async () => {
    vi.useFakeTimers();
    serve(release(CURRENT));
    await mount();
    expect(banner()).toBeNull();

    serve(release(CURRENT), release(NEWER));
    await settle(POLL_MS);
    expect(banner()?.textContent).toContain(`Safelight v${NEWER} is available.`);
  });

  it("stops once the banner is unmounted", async () => {
    vi.useFakeTimers();
    serve(release(CURRENT));
    const { unmount } = await mount();
    const callsWhileMounted = fetchMock.mock.calls.length;

    unmount();
    await settle(POLL_MS * 2);
    expect(fetchMock.mock.calls.length).toBe(callsWhileMounted);
  });
});

describe("acting on it", () => {
  it("opens the release page for the version it is offering", async () => {
    const user = userEvent.setup();
    serve(release(NEWER));
    await mount();

    await user.click(screen.getByRole("button", { name: "View release" }));
    expect(window.open).toHaveBeenCalledWith(
      expect.stringContaining(`v${NEWER}`),
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("explains why an in-app install is unavailable outside the desktop app", async () => {
    const user = userEvent.setup();
    serve(release(NEWER));
    await mount();

    await user.click(screen.getByRole("button", { name: "Download" }));
    await settle();
    expect(banner()?.textContent).toContain("only available in the desktop app");
    // The offer stays clickable so the failure isn't a dead end.
    expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
  });
});
