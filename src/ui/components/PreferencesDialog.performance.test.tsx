// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Preferences ▸ Performance on graphics that share the processor's memory: the
// Develop render resolution goes down to 2560 px, and one button sets the
// lighter settings together. The WebGL probe answers with an integrated Radeon
// here, so the section names it.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { resetSettings, updateSettings, useSettings, type AppSettings } from "@/state/settings-store";
import { openPreferences, PreferencesDialog } from "./PreferencesDialog";

class SilentChannel {
  postMessage(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

const RENDERER = "ANGLE (AMD, AMD Radeon 760M Graphics (radeonsi phoenix ACO), OpenGL ES 3.2)";
const DEBUG_INFO = { UNMASKED_VENDOR_WEBGL: 0x9245, UNMASKED_RENDERER_WEBGL: 0x9246 };

// The probe context the diagnostics read the renderer string from.
const fakeGl = {
  getExtension: (name: string) =>
    name === "WEBGL_debug_renderer_info" ? DEBUG_INFO : name === "WEBGL_lose_context" ? { loseContext() {} } : null,
  getParameter: (p: number) =>
    p === DEBUG_INFO.UNMASKED_RENDERER_WEBGL ? RENDERER : p === DEBUG_INFO.UNMASKED_VENDOR_WEBGL ? "AMD" : 0,
} as unknown as WebGL2RenderingContext;

beforeAll(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((kind: string) =>
    kind === "webgl2" ? fakeGl : null) as typeof HTMLCanvasElement.prototype.getContext);
});

afterAll(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("BroadcastChannel", SilentChannel);
  resetSettings();
});

const showPerformance = () => {
  render(<PreferencesDialog />);
  act(() => openPreferences("Performance"));
};

const LIGHT: Partial<AppSettings> = {
  developMaxEdge: 2560,
  gpuSourceCacheBytes: 256 * 1024 * 1024,
  developPrefetchNeighbors: false,
  liveHistogram: false,
};

describe("Preferences ▸ Performance on integrated graphics", () => {
  it("offers Develop render resolutions down to 2560 px", async () => {
    const user = userEvent.setup();
    showPerformance();
    for (const label of ["2560 px", "3072 px", "4096 px", "6144 px", "8192 px"]) {
      expect(screen.getByRole("button", { name: label, pressed: label === "4096 px" })).toBeTruthy();
    }
    await user.click(screen.getByRole("button", { name: "3072 px" }));
    expect(useSettings.getState().developMaxEdge).toBe(3072);
  });

  it("offers Dynamic, and choosing a size afterwards turns it off", async () => {
    const user = userEvent.setup();
    showPerformance();
    expect(screen.getByRole("button", { name: "Dynamic", pressed: false })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Dynamic" }));
    expect(useSettings.getState()).toMatchObject({ developDynamicDetail: true, developMaxEdge: 4096 });
    expect(screen.getByRole("button", { name: "Dynamic", pressed: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: "4096 px", pressed: false })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "3072 px" }));
    expect(useSettings.getState()).toMatchObject({ developDynamicDetail: false, developMaxEdge: 3072 });
  });

  it("turns Dynamic off with the integrated graphics button", async () => {
    const user = userEvent.setup();
    updateSettings({ developDynamicDetail: true });
    showPerformance();
    await user.click(screen.getByRole("button", { name: "Use integrated graphics settings" }));
    expect(useSettings.getState()).toMatchObject({ developDynamicDetail: false, developMaxEdge: 2560 });
  });

  it("names the integrated graphics it found", () => {
    showPerformance();
    expect(screen.getByText(/AMD Radeon 760M Graphics shares memory with the processor/)).toBeTruthy();
  });

  it("sets the lighter settings together with one button", async () => {
    const user = userEvent.setup();
    showPerformance();
    await user.click(screen.getByRole("button", { name: "Use integrated graphics settings" }));
    expect(useSettings.getState()).toMatchObject(LIGHT);
  });

  it("says when they're already in use", () => {
    updateSettings(LIGHT);
    showPerformance();
    const field = screen.getByText("Integrated graphics").parentElement!;
    const button = within(field).getByRole("button", { name: "Use integrated graphics settings" });
    expect(button.matches(":disabled")).toBe(true);
    expect(within(field).getByText("In use.")).toBeTruthy();
  });
});
