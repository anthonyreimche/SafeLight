// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Dragging the window to a monitor with another scale changes the device pixel
// ratio but not the histogram's CSS size, so its backing buffer must follow the
// ratio on its own. jsdom has no layout, no 2D canvas, no frame clock and no
// media queries, so each is replaced by a recorder the test drives by hand.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { Histogram } from "./Histogram";

const WIDTH = 220;
const H = 76;

class FixedWidthObserver implements ResizeObserver {
  private readonly cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(target: Element): void {
    const contentRect = { width: WIDTH, height: H } as DOMRectReadOnly;
    this.cb([{ target, contentRect } as ResizeObserverEntry], this);
  }
  unobserve(): void {}
  disconnect(): void {}
}

const transforms: number[][] = [];
const recorder = new Proxy(
  {},
  {
    get: (_, name) => {
      if (name === "setTransform") return (...m: number[]) => void transforms.push(m);
      if (name === "measureText") return () => ({ width: 0 });
      return () => {};
    },
    set: () => true,
  },
);

let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;

function flushFrame(): void {
  const due = [...frames.values()];
  frames = new Map();
  act(() => {
    for (const cb of due) cb(0);
  });
}

type ChangeListener = () => void;
let listeners = new Map<string, Set<ChangeListener>>();

function setDpr(value: number): void {
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value });
}

// A monitor change flips every query for the old ratio to "no longer matches".
function changeDpr(value: number): void {
  const old = [...listeners.entries()];
  setDpr(value);
  act(() => {
    for (const [, set] of old) for (const fn of [...set]) fn();
  });
}

const realGetContext = HTMLCanvasElement.prototype.getContext;

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", FixedWidthObserver);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => void frames.delete(id));
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query,
    matches: true,
    addEventListener: (_: string, fn: ChangeListener) => {
      if (!listeners.has(query)) listeners.set(query, new Set());
      listeners.get(query)?.add(fn);
    },
    removeEventListener: (_: string, fn: ChangeListener) => void listeners.get(query)?.delete(fn),
  }));
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => recorder,
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: realGetContext,
  });
});

beforeEach(() => {
  transforms.length = 0;
  frames = new Map();
  listeners = new Map();
  localStorage.clear();
  setDpr(1);
});

afterEach(() => {
  Reflect.deleteProperty(window, "devicePixelRatio");
});

describe("Histogram device pixel ratio", () => {
  it("reallocates its buffer when the ratio changes and the CSS size does not", () => {
    const view = render(<Histogram data={null} />);
    flushFrame();
    const canvas = view.container.querySelector("canvas") as HTMLCanvasElement;
    expect(canvas.width).toBe(WIDTH);
    expect(canvas.height).toBe(H);

    changeDpr(2);
    flushFrame();

    expect(canvas.width).toBe(WIDTH * 2);
    expect(canvas.height).toBe(H * 2);
    expect(transforms[transforms.length - 1]).toEqual([2, 0, 0, 2, 0, 0]);
  });

  it("follows the ratio back down", () => {
    setDpr(2);
    const view = render(<Histogram data={null} />);
    flushFrame();
    const canvas = view.container.querySelector("canvas") as HTMLCanvasElement;
    expect(canvas.width).toBe(WIDTH * 2);

    changeDpr(1);
    flushFrame();

    expect(canvas.width).toBe(WIDTH);
  });
});
