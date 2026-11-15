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
  const gpu = { backend: vi.fn(), setSoftware: vi.fn(), setBackend: vi.fn(), restart: vi.fn() };
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
  revertTo: null,
  reverted: null,
  keepBy: null,
};
const state = (over: Partial<NativeGpuBackendState> = {}) => Promise.resolve({ ...ON_GL, ...over });

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("BroadcastChannel", SilentChannel);
  resetSettings();
  native.bridge.platform = "linux";
  native.gpu.backend.mockReset();
  native.gpu.setBackend.mockReset();
  native.gpu.restart.mockReset();
  native.gpu.restart.mockImplementation(() => Promise.resolve());
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
      "SwiftShader (processor)",
    ]);
    expect(screen.queryByText(/restart Safelight/i)).toBeNull();
    expect(screen.queryByText(/goes back to|went back to/)).toBeNull();
  });

  // Chromium's own backend menu on macOS has OpenGL beside Metal.
  it("offers OpenGL beside Metal on macOS", async () => {
    const user = userEvent.setup();
    native.bridge.platform = "darwin";
    native.gpu.backend.mockImplementation(() =>
      state({ backend: "metal", next: "metal", backends: ["metal", "gl", "swiftshader"] }),
    );
    showRendering();
    const menu = await backendMenu();
    expect(screen.getByText("Drawing with Metal.")).toBeTruthy();
    await user.click(menu);
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Automatic",
      "Metal",
      "OpenGL",
      "SwiftShader (processor)",
    ]);
  });

  // Two of Windows' picks draw on the processor, so each says which.
  it("offers Windows' picks by name, both processor ones told apart", async () => {
    const user = userEvent.setup();
    native.bridge.platform = "win32";
    native.gpu.backend.mockImplementation(() =>
      state({ backend: "d3d11", next: "d3d11", backends: ["d3d11", "d3d11on12", "gl", "d3d11-warp", "swiftshader"] }),
    );
    showRendering();
    const menu = await backendMenu();
    expect(screen.getByText("Drawing with Direct3D 11.")).toBeTruthy();
    await user.click(menu);
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Automatic",
      "Direct3D 11",
      "Direct3D 11 on 12",
      "OpenGL",
      "WARP (processor)",
      "SwiftShader (processor)",
    ]);
  });

  it("pins a backend for the next start", async () => {
    native.gpu.setBackend.mockImplementation(() => state({ next: "vulkan", choice: "vulkan" }));
    showRendering();
    await pick("Vulkan");

    expect(native.gpu.setBackend).toHaveBeenCalledWith("vulkan");
    expect((await backendMenu()).textContent).toContain("Vulkan");
    expect(screen.getByText("Takes effect when you restart Safelight.")).toBeTruthy();
  });

  it("restarts Safelight from the field once the backend is changed", async () => {
    const user = userEvent.setup();
    native.gpu.setBackend.mockImplementation(() => state({ next: "vulkan", choice: "vulkan" }));
    showRendering();
    await backendMenu();
    expect(screen.queryByRole("button", { name: "Restart Safelight" })).toBeNull();
    await pick("Vulkan");
    await user.click(await screen.findByRole("button", { name: "Restart Safelight" }));
    expect(native.gpu.restart).toHaveBeenCalledTimes(1);
  });

  it("says so when Safelight couldn't restart", async () => {
    const user = userEvent.setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    native.gpu.setBackend.mockImplementation(() => state({ next: "vulkan", choice: "vulkan" }));
    native.gpu.restart.mockImplementation(() => Promise.reject(new Error("ipc down")));
    showRendering();
    await pick("Vulkan");
    await user.click(await screen.findByRole("button", { name: "Restart Safelight" }));
    expect(await screen.findByText("Couldn't restart Safelight. Close it and open it again.")).toBeTruthy();
    warn.mockRestore();
  });

  // Going back to what this launch already uses needs no restart.
  it("offers no restart once the change is undone", async () => {
    native.gpu.setBackend
      .mockImplementationOnce(() => state({ next: "vulkan", choice: "vulkan" }))
      .mockImplementationOnce(() => state());
    showRendering();
    await pick("Vulkan");
    expect(await screen.findByRole("button", { name: "Restart Safelight" })).toBeTruthy();
    await pick("Automatic");
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Restart Safelight" })).toBeNull();
  });

  // A change is on trial until it is kept from the window it draws.
  it("says what a pick goes back to if it doesn't work", async () => {
    native.gpu.backend.mockImplementation(() => state({ choice: "gl", next: "gl" }));
    native.gpu.setBackend.mockImplementation(() => state({ next: "vulkan", choice: "vulkan", revertTo: "gl" }));
    showRendering();
    await pick("Vulkan");
    expect(await screen.findByText("If it doesn't work or isn't kept, Safelight goes back to OpenGL.")).toBeTruthy();
    expect(screen.getByText("Takes effect when you restart Safelight.")).toBeTruthy();
  });

  it("says Automatic is on trial too", async () => {
    native.gpu.backend.mockImplementation(() => state({ choice: "gles", backend: "gles", next: "gles" }));
    native.gpu.setBackend.mockImplementation(() => state({ backend: "gles", next: "gl", choice: null, revertTo: "gles" }));
    showRendering();
    await pick("Automatic");
    expect(await screen.findByText("If it doesn't work or isn't kept, Safelight goes back to OpenGL ES.")).toBeTruthy();
  });

  it.each([
    [
      { choice: null, reverted: { from: "vulkan", because: "failed" } },
      "Vulkan didn't work on this computer, so Safelight went back to Automatic.",
    ],
    [
      { choice: "gl", reverted: { from: "auto", because: "failed" } },
      "Automatic didn't work on this computer, so Safelight went back to OpenGL.",
    ],
    [
      { choice: null, reverted: { from: "gles", because: "unkept" } },
      "OpenGL ES wasn't kept within 20 seconds, so Safelight went back to Automatic.",
    ],
  ] as const)("says which change didn't work and what Safelight went back to", async (over, text) => {
    native.gpu.backend.mockImplementation(() => state(over));
    showRendering();
    expect(await screen.findByText(text)).toBeTruthy();
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
    await pick("SwiftShader (processor)");
    await act(async () => {});
    expect(useGraphics.getState()).toMatchObject({ software: false, nextSoftware: true });
  });

  it("gives no reason for software the user picked", async () => {
    native.gpu.backend.mockImplementation(() =>
      state({ software: true, nextSoftware: true, reason: "chosen", backend: "swiftshader", next: "swiftshader", choice: "swiftshader" }),
    );
    showRendering();
    expect((await backendMenu()).textContent).toContain("SwiftShader (processor)");
    expect(screen.getByText("Drawing with SwiftShader (processor).")).toBeTruthy();
    expect(screen.queryByText(/switched to software/)).toBeNull();
    expect(screen.queryByText(/restart Safelight/i)).toBeNull();
  });
});
