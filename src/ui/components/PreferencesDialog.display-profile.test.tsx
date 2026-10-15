// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Preferences ▸ Rendering ▸ Display profile: Linux only. Picks the monitor's
// ICC profile with the native dialog, names the profile in use and the tone
// curve it is treated as, and says why when it can't use one.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { openPreferences, PreferencesDialog } from "./PreferencesDialog";
import { buildIccProfile } from "@/rendering/color-space";
import {
  READ_ERROR,
  initDisplayProfile,
  useDisplayProfile,
} from "@/rendering/display-profile-store";
import { getSettings, resetSettings, updateSettings } from "@/state/settings-store";

// Claimed once, at the first privileged call, so it's in place before any import.
const native = vi.hoisted(() => {
  const fs = { pickFile: vi.fn(), read: vi.fn() };
  const bridge = { platform: "linux", claimPrivileged: () => ({ fs, updates: {} }) };
  (globalThis as { safelightNative?: unknown }).safelightNative = bridge;
  return { fs, bridge };
});

const MONITOR = "/home/me/.local/share/icc/monitor.icc";

class SilentChannel {
  postMessage(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

let stop: () => void;

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("BroadcastChannel", SilentChannel);
  resetSettings();
  native.bridge.platform = "linux";
  native.fs.pickFile.mockReset();
  native.fs.read.mockReset();
  native.fs.read.mockImplementation((path: string) =>
    path === MONITOR
      ? Promise.resolve({ data: buildIccProfile("adobe-rgb"), mtimeMs: 0, size: 0 })
      : Promise.reject(new Error("ENOENT")),
  );
  stop = initDisplayProfile();
});

afterEach(() => {
  stop();
  useDisplayProfile.setState({ status: "off" }, true);
  vi.unstubAllGlobals();
});

const showRendering = () => {
  render(<PreferencesDialog />);
  act(() => openPreferences("Rendering"));
};

describe("Preferences ▸ Rendering ▸ Display profile", () => {
  it("isn't offered outside Linux", () => {
    native.bridge.platform = "win32";
    showRendering();
    expect(screen.queryByText("Display profile")).toBeNull();
  });

  it("shows None until a profile is chosen", () => {
    showRendering();
    expect(screen.getByText("Display profile")).toBeTruthy();
    expect(screen.getByText("None")).toBeTruthy();
  });

  it("picks an ICC profile, stores its path and names it", async () => {
    const user = userEvent.setup();
    native.fs.pickFile.mockResolvedValue(MONITOR);
    showRendering();
    await user.click(screen.getByRole("button", { name: "Choose profile…" }));

    const [filters] = native.fs.pickFile.mock.calls[0];
    expect(filters[0].extensions).toEqual(expect.arrayContaining(["icc", "icm"]));
    // Any other file would be read whole, at every launch.
    expect(filters.flatMap((f: { extensions: string[] }) => f.extensions)).not.toContain("*");
    expect(getSettings().displayProfilePath).toBe(MONITOR);
    expect(
      await screen.findByText(
        "Adobe RGB (1998) compatible. Primaries from the profile, tone curve treated as gamma 2.2.",
      ),
    ).toBeTruthy();
  });

  it("reads the profile again when the same file is chosen again", async () => {
    const user = userEvent.setup();
    act(() => updateSettings({ displayProfilePath: MONITOR }));
    native.fs.pickFile.mockResolvedValue(MONITOR);
    showRendering();
    await user.click(screen.getByRole("button", { name: "Choose profile…" }));
    await screen.findByText(/Adobe RGB/);
    expect(native.fs.read.mock.calls).toEqual([[MONITOR], [MONITOR]]);
  });

  it("keeps the profile when the dialog is cancelled", async () => {
    const user = userEvent.setup();
    act(() => updateSettings({ displayProfilePath: MONITOR }));
    native.fs.pickFile.mockResolvedValue(null);
    showRendering();
    await user.click(screen.getByRole("button", { name: "Choose profile…" }));
    expect(getSettings().displayProfilePath).toBe(MONITOR);
  });

  it("clears the profile", async () => {
    const user = userEvent.setup();
    act(() => updateSettings({ displayProfilePath: MONITOR }));
    showRendering();
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(getSettings().displayProfilePath).toBe("");
    expect(screen.getByText("None")).toBeTruthy();
  });

  it("says why it can't use the profile", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    act(() => updateSettings({ displayProfilePath: "/gone.icc" }));
    showRendering();
    expect(await screen.findByText(READ_ERROR)).toBeTruthy();
  });
});
