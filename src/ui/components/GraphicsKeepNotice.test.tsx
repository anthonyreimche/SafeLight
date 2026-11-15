// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The first launch on a graphics backend changed in Preferences asks, from its
// own window, to keep it. A window that opens but draws nothing reports no
// error, and nobody can press Keep in it, so main goes back by itself when the
// time is up; the bar counts that time down. The backend comes from the
// privileged GPU bridge, faked here.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NativeGpuBackendState } from "@/extensions/types";

const h = vi.hoisted(() => ({
  backend: null as NativeGpuBackendState | null,
  keepChange: null as unknown as () => Promise<NativeGpuBackendState>,
  revertChange: null as unknown as () => Promise<NativeGpuBackendState>,
  rendererFailed: null as unknown as (detail: string) => Promise<NativeGpuBackendState>,
}));

vi.mock("@/native/privileged", () => ({
  privilegedGpu: () =>
    h.backend && {
      backend: async () => h.backend,
      keepChange: () => h.keepChange(),
      revertChange: () => h.revertChange(),
      rendererFailed: (detail: string) => h.rendererFailed(detail),
    },
}));

import { GraphicsKeepNotice } from "./GraphicsKeepNotice";
import { useGraphics } from "@/state/graphics-store";

const NOW = 1_000_000;

const onTrial = (over: Partial<NativeGpuBackendState> = {}): NativeGpuBackendState => ({
  software: false,
  nextSoftware: false,
  reason: null,
  backend: "vulkan",
  next: "vulkan",
  choice: "vulkan",
  backends: ["gl", "gles", "vulkan", "swiftshader"],
  revertTo: "auto",
  reverted: null,
  keepBy: NOW + 20_000,
  ...over,
});

const settle = () => act(async () => {});
const bar = () => screen.queryByRole("status");

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  useGraphics.setState({ keep: null, webgl2: "yes", reason: null });
  h.backend = onTrial();
  h.keepChange = vi.fn(async () => onTrial({ revertTo: null, keepBy: null }));
  h.revertChange = vi.fn(async () => onTrial());
  h.rendererFailed = vi.fn(async () => onTrial({ revertTo: null, keepBy: null }));
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("GraphicsKeepNotice", () => {
  it("asks to keep the backend this launch draws with, and when it goes back", async () => {
    render(<GraphicsKeepNotice />);
    await settle();
    expect(bar()?.textContent).toContain("Safelight is now drawing with Vulkan.");
    expect(bar()?.textContent).toContain("Keep this graphics setting? Safelight goes back to Automatic in 20 s.");
  });

  it("names the pick it goes back to, and Automatic as the change", async () => {
    h.backend = onTrial({ backend: "gl", choice: null, revertTo: "gles" });
    render(<GraphicsKeepNotice />);
    await settle();
    expect(bar()?.textContent).toContain("Safelight is now drawing with OpenGL.");
    expect(bar()?.textContent).toContain("Safelight goes back to OpenGL ES in 20 s.");
  });

  it("counts down to the moment main goes back", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    render(<GraphicsKeepNotice />);
    await settle();
    vi.spyOn(Date, "now").mockReturnValue(NOW + 6_200);
    act(() => vi.advanceTimersByTime(1_000));
    expect(bar()?.textContent).toContain("in 14 s.");
    vi.spyOn(Date, "now").mockReturnValue(NOW + 25_000);
    act(() => vi.advanceTimersByTime(1_000));
    expect(bar()?.textContent).toContain("in 0 s.");
  });

  it("keeps the change, and goes", async () => {
    render(<GraphicsKeepNotice />);
    await settle();
    await userEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(h.keepChange).toHaveBeenCalledTimes(1);
    expect(bar()).toBeNull();
  });

  it("goes back at once", async () => {
    render(<GraphicsKeepNotice />);
    await settle();
    await userEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(h.revertChange).toHaveBeenCalledTimes(1);
  });

  it("says so when the setting couldn't change", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    h.keepChange = vi.fn(async () => {
      throw new Error("ipc closed");
    });
    render(<GraphicsKeepNotice />);
    await settle();
    await userEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(bar()?.textContent).toContain("Couldn't change the graphics setting.");
  });

  // Vulkan on Mesa's software driver: Chromium reports WebGL on, but no
  // context can be made, so main sees nothing wrong. The window's own probe does.
  it("reports a change whose window can't start WebGL2, which goes back as failed", async () => {
    useGraphics.setState({ webgl2: "no", reason: "WebGL2 not supported" });
    render(<GraphicsKeepNotice />);
    await settle();
    expect(h.rendererFailed).toHaveBeenCalledWith("WebGL2 couldn't start: WebGL2 not supported.");
    expect(h.rendererFailed).toHaveBeenCalledTimes(1);
    expect(bar()).toBeNull();
  });

  it("reports a missing WebGL2 only while trying a change", async () => {
    useGraphics.setState({ webgl2: "no", reason: "WebGL2 not supported" });
    h.backend = onTrial({ keepBy: null, revertTo: null });
    render(<GraphicsKeepNotice />);
    await settle();
    expect(h.rendererFailed).not.toHaveBeenCalled();
  });

  it("says nothing on a launch that isn't trying a change", async () => {
    h.backend = onTrial({ keepBy: null, revertTo: null });
    render(<GraphicsKeepNotice />);
    await settle();
    expect(bar()).toBeNull();
  });

  it("says nothing where Safelight doesn't choose the backend", async () => {
    h.backend = null;
    render(<GraphicsKeepNotice />);
    await settle();
    expect(bar()).toBeNull();
  });

  it("shows only in the main window", async () => {
    window.history.replaceState({}, "", "/?detached=library");
    render(<GraphicsKeepNotice />);
    await settle();
    expect(bar()).toBeNull();
  });
});
