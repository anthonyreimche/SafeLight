// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A theme's window material: which values are real, which systems can draw
// them, and the saved choice the next launch's first paint reads.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyMaterial,
  parseMaterial,
  readMaterial,
  windowOptions,
  writeMaterial,
} from "./window-material.cjs";

const WIN11 = { platform: "win32", release: "10.0.22621", software: false };
const WIN10 = { platform: "win32", release: "10.0.19045", software: false };
const MAC = { platform: "darwin", release: "23.0.0", software: false };
const LINUX = { platform: "linux", release: "6.1.0", software: false };

function window() {
  return { setBackgroundMaterial: vi.fn(), setVibrancy: vi.fn(), setBackgroundColor: vi.fn() };
}

describe("parseMaterial", () => {
  it("keeps the two materials and drops everything else", () => {
    expect(parseMaterial("acrylic")).toBe("acrylic");
    expect(parseMaterial("mica")).toBe("mica");
    for (const bad of ["tabbed", "none", "", "MICA", null, undefined, 3, {}]) {
      expect(parseMaterial(bad)).toBeNull();
    }
  });
});

describe("applyMaterial", () => {
  it("sets the background material on Windows 11 22H2 and later", () => {
    const win = window();
    expect(applyMaterial(win, "mica", WIN11)).toBe(true);
    expect(win.setBackgroundMaterial).toHaveBeenCalledWith("mica");
  });

  it("clears it with none and restores the opaque background", () => {
    const win = window();
    applyMaterial(win, "mica", WIN11);
    expect(win.setBackgroundColor).toHaveBeenLastCalledWith("#00000000");
    applyMaterial(win, null, WIN11);
    expect(win.setBackgroundMaterial).toHaveBeenLastCalledWith("none");
    expect(win.setBackgroundColor).toHaveBeenLastCalledWith("#1a1a1a");
  });

  it("does nothing on an older Windows", () => {
    const win = window();
    expect(applyMaterial(win, "acrylic", WIN10)).toBe(false);
    expect(win.setBackgroundMaterial).not.toHaveBeenCalled();
  });

  it("sets vibrancy on macOS and clears it with null", () => {
    const win = window();
    expect(applyMaterial(win, "acrylic", MAC)).toBe(true);
    expect(win.setVibrancy).toHaveBeenLastCalledWith(expect.any(String));
    applyMaterial(win, null, MAC);
    expect(win.setVibrancy).toHaveBeenLastCalledWith(null);
  });

  it("does nothing elsewhere", () => {
    const win = window();
    expect(applyMaterial(win, "mica", LINUX)).toBe(false);
    expect(win.setBackgroundMaterial).not.toHaveBeenCalled();
    expect(win.setVibrancy).not.toHaveBeenCalled();
  });

  it("is forced off on the software backend", () => {
    const win = window();
    applyMaterial(win, "mica", { ...WIN11, software: true });
    expect(win.setBackgroundMaterial).toHaveBeenCalledWith("none");
  });

  it("survives a window that refuses", () => {
    const win = window();
    win.setBackgroundMaterial.mockImplementation(() => {
      throw new Error("no");
    });
    expect(applyMaterial(win, "mica", WIN11)).toBe(false);
  });
});

describe("windowOptions", () => {
  it("builds the first-paint option for the saved material", () => {
    expect(windowOptions("mica", WIN11)).toEqual({ backgroundMaterial: "mica", backgroundColor: "#00000000" });
    expect(windowOptions("mica", MAC)).toEqual({ vibrancy: expect.any(String), backgroundColor: "#00000000" });
  });

  it("keeps the opaque background without a material, off a supporting system, or in software", () => {
    const opaque = { backgroundColor: "#1a1a1a" };
    expect(windowOptions(null, WIN11)).toEqual(opaque);
    expect(windowOptions("mica", WIN10)).toEqual(opaque);
    expect(windowOptions("mica", LINUX)).toEqual(opaque);
    expect(windowOptions("mica", { ...WIN11, software: true })).toEqual(opaque);
  });
});

describe("the saved material", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sl-material-"));
  afterEach(() => fs.rmSync(path.join(dir, "m"), { force: true }));

  it("round trips and reads back null for a missing or odd file", () => {
    const file = path.join(dir, "m");
    expect(readMaterial(file)).toBeNull();
    writeMaterial(file, "acrylic");
    expect(readMaterial(file)).toBe("acrylic");
    writeMaterial(file, null);
    expect(readMaterial(file)).toBeNull();
    fs.writeFileSync(file, "tabbed");
    expect(readMaterial(file)).toBeNull();
  });
});
