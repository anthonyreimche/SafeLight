// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A crossfade copies what a canvas shows into an overlay laid over it, shows the
// copy at full opacity, and lets it ease out over whatever is drawn beneath next.
// The ease starts two animation frames later, once the opaque copy has been
// painted; animation frames are run by hand here.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelCrossfade, snapshotCrossfade } from "./canvas-crossfade";

let frameQueue: Map<number, FrameRequestCallback>;
let copies: { into: HTMLCanvasElement; image: unknown }[];
let canvasContext: PropertyDescriptor | undefined;

function nextFrame() {
  const due = [...frameQueue.values()];
  frameQueue.clear();
  for (const cb of due) cb(0);
}

function canvas(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return c;
}

beforeEach(() => {
  frameQueue = new Map();
  let nextId = 1;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = nextId++;
    frameQueue.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frameQueue.delete(id));
  copies = [];
  canvasContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: function getContext(this: HTMLCanvasElement) {
      const into = this;
      return { drawImage: (image: unknown) => copies.push({ into, image }) };
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.documentElement.classList.remove("sl-reduce-motion");
  if (canvasContext) {
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", canvasContext);
  }
});

describe("snapshotCrossfade", () => {
  it("copies the frame on screen into the overlay and shows it at once", () => {
    const from = canvas(600, 400);
    const overlay = canvas(10, 10);

    expect(snapshotCrossfade(from, overlay, 150)).toBe(true);

    expect(copies).toEqual([{ into: overlay, image: from }]);
    expect(overlay.width).toBe(600);
    expect(overlay.height).toBe(400);
    expect(overlay.style.opacity).toBe("1");
    expect(overlay.style.transition).toBe("none");
  });

  it("eases the copy out over the time asked, from the second animation frame", () => {
    const overlay = canvas(10, 10);
    snapshotCrossfade(canvas(600, 400), overlay, 220);

    nextFrame();
    expect(overlay.style.opacity).toBe("1");
    expect(overlay.style.transition).toBe("none");

    nextFrame();
    expect(overlay.style.transition).toBe("opacity 220ms ease-out");
    expect(overlay.style.opacity).toBe("0");
  });

  it("does nothing under Reduce motion", () => {
    document.documentElement.classList.add("sl-reduce-motion");
    const overlay = canvas(10, 10);

    expect(snapshotCrossfade(canvas(600, 400), overlay, 150)).toBe(false);
    nextFrame();
    nextFrame();

    expect(copies).toEqual([]);
    expect(overlay.style.opacity).not.toBe("1");
    expect(overlay.style.transition).not.toMatch(/opacity/);
  });

  it("does nothing for a canvas with nothing drawn yet", () => {
    const overlay = canvas(10, 10);
    expect(snapshotCrossfade(canvas(0, 0), overlay, 150)).toBe(false);
    expect(copies).toEqual([]);
    expect(overlay.style.opacity).not.toBe("1");
  });

  it("starts over from the newest frame when asked again mid-fade", () => {
    const first = canvas(600, 400);
    const second = canvas(300, 200);
    const overlay = canvas(10, 10);
    snapshotCrossfade(first, overlay, 150);
    nextFrame();

    snapshotCrossfade(second, overlay, 220);
    nextFrame();
    expect(overlay.style.opacity).toBe("1");
    nextFrame();

    expect(copies.at(-1)).toEqual({ into: overlay, image: second });
    expect(overlay.width).toBe(300);
    expect(overlay.style.transition).toBe("opacity 220ms ease-out");
    expect(frameQueue.size).toBe(0);
  });
});

// The copy is as big as the frame it was taken from (about 17 MB at a 2560 px long
// edge), and nothing shows it once it has faded out.
describe("the overlay's copy", () => {
  it("is let go once the fade has run its time", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const overlay = canvas(10, 10);
    snapshotCrossfade(canvas(600, 400), overlay, 150);
    nextFrame();
    nextFrame();

    vi.advanceTimersByTime(149);
    expect(overlay.width).toBe(600);
    vi.advanceTimersByTime(1);
    expect(overlay.width).toBe(0);
    expect(overlay.height).toBe(0);
  });

  it("is let go when the fade is cancelled", () => {
    const overlay = canvas(10, 10);
    snapshotCrossfade(canvas(600, 400), overlay, 150);
    cancelCrossfade(overlay);
    expect(overlay.width).toBe(0);
    expect(overlay.height).toBe(0);
  });

  it("is never taken under Reduce motion", () => {
    document.documentElement.classList.add("sl-reduce-motion");
    const overlay = canvas(10, 10);
    snapshotCrossfade(canvas(600, 400), overlay, 150);
    expect(overlay.width).toBe(0);
  });

  it("of a newer fade is kept when an older fade's time runs out", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const overlay = canvas(10, 10);
    snapshotCrossfade(canvas(600, 400), overlay, 150);
    nextFrame();
    nextFrame();
    vi.advanceTimersByTime(100);

    snapshotCrossfade(canvas(300, 200), overlay, 220);
    vi.advanceTimersByTime(100);
    expect(overlay.width).toBe(300);
  });
});

describe("cancelCrossfade", () => {
  it("hides the overlay at once and keeps the fade from starting later", () => {
    const overlay = canvas(10, 10);
    snapshotCrossfade(canvas(600, 400), overlay, 150);
    nextFrame();

    cancelCrossfade(overlay);
    expect(overlay.style.opacity).toBe("0");
    expect(overlay.style.transition).toBe("none");

    nextFrame();
    nextFrame();
    expect(overlay.style.opacity).toBe("0");
    expect(overlay.style.transition).toBe("none");
  });

  it("snaps a fade already easing to its end", () => {
    const overlay = canvas(10, 10);
    snapshotCrossfade(canvas(600, 400), overlay, 150);
    nextFrame();
    nextFrame();

    cancelCrossfade(overlay);
    expect(overlay.style.opacity).toBe("0");
    expect(overlay.style.transition).toBe("none");
  });
});
