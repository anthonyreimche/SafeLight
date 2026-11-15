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
// The globalAlpha each curve was filled with.
let alphas: number[] = [];
let alpha = 1;
const recorder = new Proxy(
  {},
  {
    get: (_, name) => {
      if (name === "beginPath") return () => (path = []);
      if (name === "lineTo")
        return (x: number, y: number) => void path.push([x, y]);
      if (name === "fill")
        return () => {
          curves.push(path);
          alphas.push(alpha);
        };
      if (name === "measureText") return () => ({ width: 0 });
      return () => {};
    },
    set: (_, name, value) => {
      if (name === "globalAlpha") alpha = value;
      return true;
    },
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
  alphas = [];
  alpha = 1;
  frames = new Map();
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
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

describe("Histogram fade-in", () => {
  let clock = 1000;
  beforeEach(() => {
    clock = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
  });

  const lastAlpha = () => alphas[alphas.length - 1];

  it("ramps the curve in from transparent after a real wait for data", () => {
    const view = render(<Histogram data={null} />);
    clock += 300;
    view.rerender(<Histogram data={data(50)} />);
    flushFrame();
    expect(lastAlpha()).toBeLessThan(1);
    expect(frames.size).toBe(1);
    clock += 75;
    flushFrame();
    expect(lastAlpha()).toBeGreaterThan(0);
    expect(lastAlpha()).toBeLessThan(1);
    clock += 100;
    flushFrame();
    expect(lastAlpha()).toBe(1);
    expect(frames.size).toBe(0);
  });

  it("draws at full alpha at once with Reduce motion on", () => {
    document.documentElement.classList.add("sl-reduce-motion");
    const view = render(<Histogram data={null} />);
    clock += 300;
    view.rerender(<Histogram data={data(50)} />);
    flushFrame();
    expect(lastAlpha()).toBe(1);
    expect(frames.size).toBe(0);
  });

  it("skips the ramp when the data was missing only briefly", () => {
    const view = mountWithA();
    view.rerender(<Histogram data={null} />);
    clock += 50;
    view.rerender(<Histogram data={data(80)} />);
    flushFrame();
    expect(lastAlpha()).toBe(1);
    expect(frames.size).toBe(0);
  });

  // A canvas with no 2D context draws nothing, but the ramp still ends on time: left
  // running, the tick asked for a frame on every frame for good.
  it("ends the ramp on time on a canvas with no 2D context", () => {
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: () => null,
    });
    try {
      const view = render(<Histogram data={null} />);
      clock += 300;
      view.rerender(<Histogram data={data(50)} />);
      flushFrame();
      clock += 200;
      flushFrame();
      flushFrame();
      expect(frames.size).toBe(0);
    } finally {
      Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
        configurable: true,
        value: () => recorder,
      });
    }
  });

  it("ramps again after a long gap between photos", () => {
    const view = mountWithA();
    view.rerender(<Histogram data={null} />);
    clock += 400;
    view.rerender(<Histogram data={data(80)} />);
    flushFrame();
    expect(lastAlpha()).toBeLessThan(1);
  });
});
