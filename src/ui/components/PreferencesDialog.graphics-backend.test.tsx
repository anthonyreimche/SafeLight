// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Preferences ▸ Rendering ▸ Graphics backend: wherever the GPU bridge reports a
// backend. Automatic lets Safelight probe this platform's backends and fall
// back to software by itself (a VirtualBox guest); every other entry pins one
// backend for later launches. The backend is picked before the window exists,
// so a change applies at the next start.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { openPreferences, PreferencesDialog } from "./PreferencesDialog";
import { resetSettings } from "@/state/settings-store";
import { useGraphics } from "@/state/graphics-store";
import type { NativeGpuBackendState } from "@/extensions/types";

// Claimed once, at the first privileged call, so it's in place before any import.
const native = vi.hoisted(() => {
  const gpu = { backend: vi.fn(), setSoftware: vi.fn(), setBackend: vi.fn() };
  const claim = vi.fn(() => ({ fs: {}, updates: {}, gpu }));
  const bridge = { platform: "linux", claimPrivileged: claim };
  (globalThis as { safelightNative?: unknown }).safelightNative = bridge;
  return { gpu, bridge, claim };
});

// Boot claims the privileged bridge after the app's modules load; Preferences must
// not claim it first, while it builds its search index.
const claimedAtImport = native.claim.mock.calls.length;

class SilentChannel {
  postMessage(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

const LADDER = ["gl", "gles", "vulkan", "swiftshader"];
const ON_GL: NativeGpuBackendState = {
  software: false,
  nextSoftware: false,
  reason: null,
  backend: "gl",
  next: "gl",
  choice: null,
  backends: LADDER,
};
const state = (over: Partial<NativeGpuBackendState> = {}) => Promise.resolve({ ...ON_GL, ...over });

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("BroadcastChannel", SilentChannel);
  resetSettings();
  native.bridge.platform = "linux";
  native.gpu.backend.mockReset();
  native.gpu.setBackend.mockReset();
  native.gpu.backend.mockImplementation(() => state());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const showRendering = () => {
  render(<PreferencesDialog />);
  act(() => openPreferences("Rendering"));
};

const backendMenu = () => screen.findByRole("combobox", { name: "Graphics backend" });

async function pick(label: string) {
  const user = userEvent.setup();
  await user.click(await backendMenu());
  await user.click(screen.getByRole("option", { name: label }));
}

describe("Preferences ▸ Rendering ▸ Graphics backend", () => {
  it("leaves the privileged bridge unclaimed while Preferences loads", () => {
    expect(claimedAtImport).toBe(0);
  });

  it.each(["win32", "darwin", "linux"])("is offered on %s", async (platform) => {
    native.bridge.platform = platform;
    showRendering();
    expect(await backendMenu()).toBeTruthy();
  });

  it("isn't offered when the bridge reports no backend", async () => {
    native.gpu.backend.mockImplementation(() => Promise.resolve(null));
    showRendering();
    await act(async () => {});
    expect(screen.queryByRole("combobox", { name: "Graphics backend" })).toBeNull();
  });

  it("shows a disabled menu with a reason when the backend can't be read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    native.gpu.backend.mockImplementation(() => Promise.reject(new Error("ipc down")));
    showRendering();
    const menu = await backendMenu();
    expect(menu.matches(":disabled")).toBe(true);
    expect(screen.getByText("Couldn't read the graphics setting.")).toBeTruthy();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("offers Automatic and this platform's backends, and says which one is drawing", async () => {
    const user = userEvent.setup();
    showRendering();
    const menu = await backendMenu();
    expect(menu.textContent).toContain("Automatic");
    expect(screen.getByText("Drawing with OpenGL.")).toBeTruthy();
    await user.click(menu);
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Automatic",
      "OpenGL",
      "OpenGL ES",
      "Vulkan",
      "Software (processor)",
    ]);
    expect(screen.queryByText(/restart Safelight/i)).toBeNull();
  });

  it("pins a backend for the next start", async () => {
    native.gpu.setBackend.mockImplementation(() => state({ next: "vulkan", choice: "vulkan" }));
    showRendering();
    await pick("Vulkan");

    expect(native.gpu.setBackend).toHaveBeenCalledWith("vulkan");
    expect((await backendMenu()).textContent).toContain("Vulkan");
    expect(screen.getByText("Takes effect when you restart Safelight.")).toBeTruthy();
  });

  it("goes back to Automatic", async () => {
    native.gpu.backend.mockImplementation(() => state({ backend: "vulkan", next: "vulkan", choice: "vulkan" }));
    native.gpu.setBackend.mockImplementation(() => state({ backend: "vulkan", next: "gl", choice: null }));
    showRendering();
    await pick("Automatic");

    expect(native.gpu.setBackend).toHaveBeenCalledWith(null);
    expect((await backendMenu()).textContent).toContain("Automatic");
    expect(screen.getByText("Takes effect when you restart Safelight.")).toBeTruthy();
  });

  it("keeps the pick and says so when changing it fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    native.gpu.setBackend.mockImplementation(() => Promise.reject(new Error("ipc down")));
    showRendering();
    await pick("Vulkan");
    expect(await screen.findByText("Couldn't change the graphics setting.")).toBeTruthy();
    expect((await backendMenu()).textContent).toContain("Automatic");
    warn.mockRestore();
  });

  it.each([
    ["webgl2-unavailable", "Safelight switched to software because the graphics card couldn't run WebGL2."],
    ["gpu-crashes", "Safelight switched to software because the graphics driver kept crashing."],
    ["renderer-failed", "Safelight switched to software because the graphics driver couldn't run its photo renderer."],
  ] as const)("says why Safelight switched to software by itself (%s)", async (reason, text) => {
    native.gpu.backend.mockImplementation(() =>
      state({ nextSoftware: true, reason, next: "swiftshader" }),
    );
    showRendering();
    expect(await screen.findByText(text)).toBeTruthy();
    expect((await backendMenu()).textContent).toContain("Automatic");
    expect(screen.getByText("Takes effect when you restart Safelight.")).toBeTruthy();
  });

  // The menu already reads Automatic after Safelight switched to software by
  // itself, so it says how to try the graphics card again.
  it("says how to try the graphics card again, and does so on Automatic", async () => {
    native.gpu.backend.mockImplementation(() =>
      state({ software: true, nextSoftware: true, reason: "gpu-crashes", backend: "swiftshader", next: "swiftshader" }),
    );
    native.gpu.setBackend.mockImplementation(() => state({ software: true, backend: "swiftshader", next: "gl" }));
    showRendering();
    expect(await screen.findByText(/Pick Automatic again to try the graphics card at the next start\./)).toBeTruthy();
    await pick("Automatic");
    expect(native.gpu.setBackend).toHaveBeenCalledWith(null);
    expect(await screen.findByText("Takes effect when you restart Safelight.")).toBeTruthy();
  });

  // Software Safelight chose for itself tries the graphics card again after a
  // while; nothing the user did is waiting on a restart.
  it("doesn't ask for a restart for a retry Safelight scheduled itself", async () => {
    native.gpu.backend.mockImplementation(() =>
      state({ software: true, nextSoftware: true, reason: "gpu-crashes", backend: "swiftshader", next: "gl" }),
    );
    showRendering();
    await backendMenu();
    expect(screen.queryByText(/restart Safelight/i)).toBeNull();
  });

  it("keeps the main window's graphics notice in step with the pick", async () => {
    native.gpu.setBackend.mockImplementation(() =>
      state({ nextSoftware: true, reason: "chosen", next: "swiftshader", choice: "swiftshader" }),
    );
    showRendering();
    await pick("Software (processor)");
    await act(async () => {});
    expect(useGraphics.getState()).toMatchObject({ software: false, nextSoftware: true });
  });

  it("gives no reason for software the user picked", async () => {
    native.gpu.backend.mockImplementation(() =>
      state({ software: true, nextSoftware: true, reason: "chosen", backend: "swiftshader", next: "swiftshader", choice: "swiftshader" }),
    );
    showRendering();
    expect((await backendMenu()).textContent).toContain("Software (processor)");
    expect(screen.getByText("Drawing with Software (processor).")).toBeTruthy();
    expect(screen.queryByText(/switched to software/)).toBeNull();
    expect(screen.queryByText(/restart Safelight/i)).toBeNull();
  });
});
