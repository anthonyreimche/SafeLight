// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The histogram glides toward new data over several frames. The app's Reduce
// motion setting (the sl-reduce-motion class on <html>) must make it snap: the
// next frame draws the new data and schedules nothing further. jsdom has no
// layout, no 2D canvas and no frame clock, so each is replaced by a recorder
// the test drives by hand.

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { act, render } from "@testing-library/react";
import { Histogram } from "./Histogram";
import type { HistogramData } from "@/rendering/histogram";

const BINS = 256;
const H = 76;

function data(peakBin: number): HistogramData {
  const luma = new Uint32Array(BINS).fill(10);
  luma[peakBin] = 1000;
  return {
    r: new Uint32Array(BINS),
    g: new Uint32Array(BINS),
    b: new Uint32Array(BINS),
    luma,
  };
}

function resizeEntry(target: Element, width: number): ResizeObserverEntry {
  const box: ResizeObserverSize = { inlineSize: width, blockSize: H };
  const contentRect: DOMRectReadOnly = {
    x: 0,
    y: 0,
    width,
    height: H,
    top: 0,
    left: 0,
    right: width,
    bottom: H,
    toJSON: () => ({}),
  };
  return {
    target,
    contentRect,
    borderBoxSize: [box],
    contentBoxSize: [box],
    devicePixelContentBoxSize: [box],
  };
}

class FixedWidthObserver implements ResizeObserver {
  private readonly cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(target: Element): void {
    this.cb([resizeEntry(target, 220)], this);
  }
  unobserve(): void {}
  disconnect(): void {}
}

// Every filled curve, as the list of [x, y] points it was built from.
let curves: Array<Array<[number, number]>> = [];
let path: Array<[number, number]> = [];
const recorder = new Proxy(
  {},
  {
    get: (_, name) => {
      if (name === "beginPath") return () => (path = []);
      if (name === "lineTo")
        return (x: number, y: number) => void path.push([x, y]);
      if (name === "fill") return () => void curves.push(path);
      if (name === "measureText") return () => ({ width: 0 });
      return () => {};
    },
    set: () => true,
  },
);

let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;

// Runs the frames queued right now; frames they request wait for the next call.
function flushFrame(): void {
  const due = [...frames.values()];
  frames = new Map();
  act(() => {
    for (const cb of due) cb(0);
  });
}

// The point of the highest bump (smallest y) in the most recent curve.
function peakBin(): number {
  const last = curves[curves.length - 1].slice(0, BINS);
  return last.reduce((best, p, i) => (p[1] < last[best][1] ? i : best), 0);
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
  curves = [];
  path = [];
  frames = new Map();
  localStorage.clear();
});

afterEach(() => {
  document.documentElement.classList.remove("sl-reduce-motion");
});

function mountWithA() {
  const view = render(<Histogram data={data(50)} />);
  flushFrame();
  expect(peakBin()).toBe(50);
  expect(frames.size).toBe(0);
  return view;
}

describe("Histogram motion", () => {
  it("glides toward new data over several frames by default", () => {
    const view = mountWithA();
    view.rerender(<Histogram data={data(100)} />);
    flushFrame();
    expect(peakBin()).toBe(50);
    expect(frames.size).toBe(1);
  });

  it("with Reduce motion on, draws the new data on the next frame and stops", () => {
    const view = mountWithA();
    document.documentElement.classList.add("sl-reduce-motion");
    view.rerender(<Histogram data={data(100)} />);
    flushFrame();
    expect(peakBin()).toBe(100);
    const drawn = curves[curves.length - 1];
    expect(drawn[100][1]).toBe(1);
    expect(drawn[50][1]).toBeCloseTo(H - (10 / 1000) * (H - 1));
    expect(frames.size).toBe(0);
  });

  it("follows the setting being turned on while a glide is under way", () => {
    const view = mountWithA();
    view.rerender(<Histogram data={data(100)} />);
    flushFrame();
    expect(frames.size).toBe(1);
    document.documentElement.classList.add("sl-reduce-motion");
    flushFrame();
    expect(peakBin()).toBe(100);
    expect(frames.size).toBe(0);
  });
});
