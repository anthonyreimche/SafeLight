// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The mode buttons announce their state and have a real hit area; the canvas
// takes its colours from theme custom properties and re-reads them on a theme
// change.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { Histogram } from "./Histogram";
import { useThemeStore } from "@/extensions/themes";
import type { HistogramData } from "@/rendering/histogram";

const bins = () => new Uint32Array(256).fill(10);
const data: HistogramData = { r: bins(), g: bins(), b: bins(), luma: bins() };

const fills: string[] = [];
const strokes: string[] = [];

beforeEach(() => {
  fills.length = 0;
  strokes.length = 0;
  localStorage.clear();
  const ctx = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === "measureText") return () => ({ width: 10 });
        return () => {};
      },
      set: (_t, prop, value) => {
        if (prop === "fillStyle") fills.push(String(value));
        if (prop === "strokeStyle") strokes.push(String(value));
        return true;
      },
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D,
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("style");
});

describe("histogram mode buttons", () => {
  it("expose their pressed state", () => {
    render(<Histogram data={data} onToggleClipping={() => {}} showClipping={0} />);
    expect(screen.getByRole("button", { name: "Lum" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "RGB" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Clip" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("show the clip button as pressed while the overlay is on", () => {
    render(<Histogram data={data} onToggleClipping={() => {}} showClipping={3} />);
    expect(screen.getByRole("button", { name: "Clip" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("have at least a 24px hit area", () => {
    render(<Histogram data={data} onToggleClipping={() => {}} />);
    for (const name of ["Lum", "RGB", "R", "G", "B", "Clip"]) {
      expect(screen.getByRole("button", { name }).className).toContain("min-h-6");
    }
  });

  it("colour their active state with theme tokens, not hex", () => {
    render(<Histogram data={data} onToggleClipping={() => {}} showClipping={3} />);
    expect(screen.getByRole("button", { name: "Lum" }).style.color).toBe("var(--color-text-secondary)");
    expect(screen.getByRole("button", { name: "Clip" }).style.color).toBe("var(--color-danger)");
  });
});

describe("histogram canvas colours", () => {
  it("draws the luma curve in the --histogram-curve token", () => {
    document.documentElement.style.setProperty("--histogram-curve", "rgb(1, 2, 3)");
    render(<Histogram data={data} />);
    expect(fills).toContain("rgb(1, 2, 3)");
  });

  it("falls back to the stock colours without a token", () => {
    render(<Histogram data={data} />);
    expect(fills).toContain("rgba(208,208,208,0.85)");
  });

  it("re-reads the tokens when the theme changes", () => {
    document.documentElement.style.setProperty("--histogram-curve", "rgb(1, 2, 3)");
    render(<Histogram data={data} />);
    fills.length = 0;
    document.documentElement.style.setProperty("--histogram-curve", "rgb(9, 8, 7)");
    act(() => useThemeStore.setState({ activeId: "test.other" }));
    expect(fills).toContain("rgb(9, 8, 7)");
    act(() => useThemeStore.setState({ activeId: "core.neutral" }));
  });

  it("draws the zone dividers in the --histogram-grid token", () => {
    document.documentElement.style.setProperty("--histogram-grid", "rgb(4, 5, 6)");
    render(<Histogram data={data} onAdjust={() => {}} />);
    expect(strokes).toContain("rgb(4, 5, 6)");
  });
});
