// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Preferences ▸ Rendering ▸ Software rendering: Linux only. Safelight turns it
// on by itself when the graphics card can't run WebGL2 (a VirtualBox guest);
// the switch says so and is the way back. The backend is picked before the
// window exists, so a change applies at the next start.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { openPreferences, PreferencesDialog } from "./PreferencesDialog";
import { resetSettings } from "@/state/settings-store";
import type { NativeGpuBackendState } from "@/extensions/types";

// Claimed once, at the first privileged call, so it's in place before any import.
const native = vi.hoisted(() => {
  const gpu = { backend: vi.fn(), setSoftware: vi.fn() };
  const bridge = { platform: "linux", claimPrivileged: () => ({ fs: {}, updates: {}, gpu }) };
  (globalThis as { safelightNative?: unknown }).safelightNative = bridge;
  return { gpu, bridge };
});

class SilentChannel {
  postMessage(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

const state = (s: NativeGpuBackendState) => Promise.resolve(s);
const GRAPHICS_CARD: NativeGpuBackendState = { software: false, nextSoftware: false, reason: null };

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("BroadcastChannel", SilentChannel);
  resetSettings();
  native.bridge.platform = "linux";
  native.gpu.backend.mockReset();
  native.gpu.setSoftware.mockReset();
  native.gpu.backend.mockImplementation(() => state(GRAPHICS_CARD));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const showRendering = () => {
  render(<PreferencesDialog />);
  act(() => openPreferences("Rendering"));
};

const softwareSwitch = () => screen.findByRole("switch", { name: "Software rendering" });

describe("Preferences ▸ Rendering ▸ Software rendering", () => {
  it("isn't offered outside Linux", async () => {
    native.bridge.platform = "win32";
    showRendering();
    await act(async () => {});
    expect(screen.queryByRole("switch", { name: "Software rendering" })).toBeNull();
  });

  it("is off while Safelight draws on the graphics card", async () => {
    showRendering();
    expect((await softwareSwitch()).getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByText(/restart Safelight/i)).toBeNull();
  });

  it("says Safelight turned it on because WebGL2 was unavailable", async () => {
    native.gpu.backend.mockImplementation(() =>
      state({ software: true, nextSoftware: true, reason: "webgl2-unavailable" }),
    );
    showRendering();
    expect((await softwareSwitch()).getAttribute("aria-checked")).toBe("true");
    expect(
      screen.getByText("Safelight turned this on because the graphics card couldn't run WebGL2."),
    ).toBeTruthy();
  });

  it("says Safelight turned it on because the graphics driver kept crashing", async () => {
    native.gpu.backend.mockImplementation(() =>
      state({ software: false, nextSoftware: true, reason: "gpu-crashes" }),
    );
    showRendering();
    expect(
      await screen.findByText("Safelight turned this on because the graphics driver kept crashing."),
    ).toBeTruthy();
    expect(screen.getByText("Takes effect when you restart Safelight.")).toBeTruthy();
  });

  it("goes back to the graphics card at the next start", async () => {
    const user = userEvent.setup();
    native.gpu.backend.mockImplementation(() =>
      state({ software: true, nextSoftware: true, reason: "webgl2-unavailable" }),
    );
    native.gpu.setSoftware.mockImplementation(() =>
      state({ software: true, nextSoftware: false, reason: null }),
    );
    showRendering();
    await user.click(await softwareSwitch());

    expect(native.gpu.setSoftware).toHaveBeenCalledWith(false);
    expect((await softwareSwitch()).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Takes effect when you restart Safelight.")).toBeTruthy();
    expect(screen.queryByText(/Safelight turned this on/)).toBeNull();
  });

  it("can be turned on by hand", async () => {
    const user = userEvent.setup();
    native.gpu.setSoftware.mockImplementation(() =>
      state({ software: false, nextSoftware: true, reason: "chosen" }),
    );
    showRendering();
    await user.click(await softwareSwitch());

    expect(native.gpu.setSoftware).toHaveBeenCalledWith(true);
    expect((await softwareSwitch()).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Takes effect when you restart Safelight.")).toBeTruthy();
    expect(screen.queryByText(/Safelight turned this on/)).toBeNull();
  });
});
