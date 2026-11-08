// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// window:setTitleBarOverlay: the native controls follow the Interface scale.

import { afterEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import { windowChannels } from "./window.cjs";

type Handler = (event: unknown, color: string, symbolColor: string, uiScale?: number) => void;

const realPlatform = process.platform;
const setPlatform = (platform: string) =>
  Object.defineProperty(process, "platform", { value: platform });

function setup() {
  const win = { setTitleBarOverlay: vi.fn(), setWindowButtonPosition: vi.fn() };
  const channels = windowChannels({
    appVersion: () => "0",
    BrowserWindow: { fromWebContents: () => win },
    takeOsOpen: () => null,
  } as never) as { channel: string; handler: Handler }[];
  const handler = channels.find((c) => c.channel === "window:setTitleBarOverlay")!.handler;
  return { win, handler };
}

afterEach(() => setPlatform(realPlatform));

describe("window:setTitleBarOverlay", () => {
  it.each([
    [0.8, 29],
    [1, 36],
    [1.5, 54],
    [2, 72],
  ])("sizes the Windows/Linux overlay for scale %s", (scale, height) => {
    setPlatform("win32");
    const { win, handler } = setup();
    handler({ sender: {} }, "#111", "#eee", scale);
    expect(win.setTitleBarOverlay).toHaveBeenCalledWith({
      color: "#111",
      symbolColor: "#eee",
      height,
    });
  });

  it("keeps the 36px overlay when no scale is sent", () => {
    setPlatform("linux");
    const { win, handler } = setup();
    handler({ sender: {} }, "#111", "#eee");
    expect(win.setTitleBarOverlay).toHaveBeenCalledWith(expect.objectContaining({ height: 36 }));
  });

  it.each([
    [0.8, 8],
    [1, 12],
    [2, 31],
  ])("centres the macOS traffic lights in the bar at scale %s", (scale, y) => {
    setPlatform("darwin");
    const { win, handler } = setup();
    handler({ sender: {} }, "#111", "#eee", scale);
    expect(win.setTitleBarOverlay).not.toHaveBeenCalled();
    expect(win.setWindowButtonPosition).toHaveBeenCalledWith({ x: 12, y });
  });
});

describe("window:setMaterial", () => {
  function materialSetup(extra: Record<string, unknown> = {}) {
    const win = {
      setBackgroundMaterial: vi.fn(),
      setVibrancy: vi.fn(),
      setBackgroundColor: vi.fn(),
    };
    const saveMaterial = vi.fn();
    const channels = windowChannels({
      appVersion: () => "0",
      BrowserWindow: { fromWebContents: () => win },
      takeOsOpen: () => null,
      saveMaterial,
      isSoftware: () => false,
      ...extra,
    } as never) as { channel: string; privileged: boolean; handler: (e: unknown, m: unknown) => void }[];
    return { win, saveMaterial, channel: channels.find((c) => c.channel === "window:setMaterial")! };
  }

  it("is privileged", () => {
    expect(materialSetup().channel.privileged).toBe(true);
  });

  it("applies and saves a real material on Windows 11", () => {
    setPlatform("win32");
    vi.spyOn(os, "release").mockReturnValue("10.0.22621");
    const { win, saveMaterial, channel } = materialSetup();
    channel.handler({ sender: {} }, "acrylic");
    expect(win.setBackgroundMaterial).toHaveBeenCalledWith("acrylic");
    expect(saveMaterial).toHaveBeenCalledWith("acrylic");
    vi.restoreAllMocks();
  });

  it("treats a bad value as clearing", () => {
    setPlatform("win32");
    vi.spyOn(os, "release").mockReturnValue("10.0.22621");
    const { win, saveMaterial, channel } = materialSetup();
    channel.handler({ sender: {} }, "tabbed");
    expect(win.setBackgroundMaterial).toHaveBeenCalledWith("none");
    expect(saveMaterial).toHaveBeenCalledWith(null);
    vi.restoreAllMocks();
  });

  it("is a no-op off Windows and macOS", () => {
    setPlatform("linux");
    const { win, saveMaterial, channel } = materialSetup();
    channel.handler({ sender: {} }, "mica");
    expect(win.setBackgroundMaterial).not.toHaveBeenCalled();
    expect(win.setVibrancy).not.toHaveBeenCalled();
    expect(saveMaterial).not.toHaveBeenCalled();
  });
});

describe("window:setTitleBarOverlay colours", () => {
  it("skips a colour that is not hex instead of failing silently", () => {
    setPlatform("win32");
    const { win, handler } = setup();
    handler({ sender: {} }, "rgba(10, 20, 30, 0.5)", "#eee", 1);
    expect(win.setTitleBarOverlay).not.toHaveBeenCalled();
  });

  it("accepts #AARRGGBB", () => {
    setPlatform("win32");
    const { win, handler } = setup();
    handler({ sender: {} }, "#0a141e80", "#eeeeee", 1);
    expect(win.setTitleBarOverlay).toHaveBeenCalled();
  });
});
