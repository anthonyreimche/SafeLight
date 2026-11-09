// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The mode buttons announce their state and have a real hit area; the canvas
// takes its colours from theme custom properties and re-reads them on a theme
// change.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
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

describe("histogram drag", () => {
  type Adjust = NonNullable<React.ComponentProps<typeof Histogram>["onAdjust"]>;

  const mount = () => {
    const onAdjust = vi.fn<Adjust>();
    const { container } = render(<Histogram data={data} onAdjust={onAdjust} />);
    const canvas = container.querySelector("canvas");
    if (!canvas) throw new Error("no canvas");
    return { canvas, onAdjust };
  };

  const phases = (onAdjust: Mock<Adjust>) => onAdjust.mock.calls.map((c) => c[2]);

  it("ends the edit at the last offset when the browser cancels the pointer", () => {
    const { canvas, onAdjust } = mount();
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 100, clientY: 40 });
    const zone = onAdjust.mock.calls[0][0];
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 130, clientY: 40 });
    fireEvent.pointerCancel(canvas, { pointerId: 1, clientX: 0, clientY: 0 });
    expect(onAdjust).toHaveBeenLastCalledWith(zone, 30, "end");

    onAdjust.mockClear();
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 160, clientY: 40 });
    expect(phases(onAdjust)).not.toContain("move");
  });

  it("ends the edit when the canvas loses its pointer capture", () => {
    const { canvas, onAdjust } = mount();
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 100, clientY: 40 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 90, clientY: 40 });
    fireEvent.lostPointerCapture(canvas, { pointerId: 1 });
    expect(phases(onAdjust)).toEqual(["start", "move", "end"]);
    expect(onAdjust.mock.calls[2][1]).toBe(-10);
  });

  it("ends a released drag once, not again when the capture goes", () => {
    const { canvas, onAdjust } = mount();
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 100, clientY: 40 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 120, clientY: 40 });
    fireEvent.lostPointerCapture(canvas, { pointerId: 1 });
    expect(phases(onAdjust).filter((p) => p === "end")).toHaveLength(1);
  });
});
