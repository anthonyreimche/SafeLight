// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A crossfade copies what a canvas shows into an overlay laid over it, shows the
// copy at full opacity, and lets it ease out over whatever is drawn beneath next.
// With Element.animate the ease starts on the next frame. Without it, it falls back
// to a CSS transition, which starts two animation frames later, once the opaque copy
// has been painted; animation frames are run by hand here. The DOM test setup gives
// every element a stand-in animate, so each test says which path it takes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelCrossfade, crossfading, snapshotCrossfade } from "./canvas-crossfade";
import { EASE_OUT } from "./motion";

let frameQueue: Map<number, FrameRequestCallback>;
let copies: { into: HTMLCanvasElement; image: unknown }[];
/** The options each getContext("2d") was given, in order. */
let contextOptions: unknown[];
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

/** Takes the CSS fallback: no Element.animate on canvases. */
function withoutAnimate() {
  Object.defineProperty(HTMLCanvasElement.prototype, "animate", { configurable: true, value: undefined });
}

beforeEach(() => {
  withoutAnimate();
  frameQueue = new Map();
  let nextId = 1;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = nextId++;
    frameQueue.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frameQueue.delete(id));
  copies = [];
  contextOptions = [];
  canvasContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: function getContext(this: HTMLCanvasElement, _type: string, options?: unknown) {
      const into = this;
      contextOptions.push(options);
      return { drawImage: (image: unknown) => copies.push({ into, image }) };
    },
  });
});

afterEach(() => {
  Reflect.deleteProperty(HTMLCanvasElement.prototype, "animate");
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

  // The display canvas holds P3 pixels on a P3 screen; a copy in an sRGB context
  // would squeeze them back to sRGB.
  it.each([
    [true, "display-p3"],
    [false, "srgb"],
  ])("takes the copy in a context for the screen's space (P3 screen: %s)", (p3, colorSpace) => {
    vi.stubGlobal("matchMedia", () => ({ matches: p3 }));
    snapshotCrossfade(canvas(600, 400), canvas(10, 10), 150);
    expect(contextOptions).toEqual([{ colorSpace }]);
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

// Started from script, the fade needs no painted frame of the opaque copy first: the
// animation's first frame shows it, so the copy no longer covers the new frame for two
// frames before it starts to ease.
describe("with Element.animate", () => {
  class FakeAnimation {
    onfinish: (() => void) | null = null;
    oncancel: (() => void) | null = null;
    cancelled = false;
    readonly keyframes: Keyframe[];
    readonly options: KeyframeAnimationOptions;
    constructor(keyframes: Keyframe[], options: KeyframeAnimationOptions) {
      this.keyframes = keyframes;
      this.options = options;
    }
    cancel() {
      this.cancelled = true;
    }
  }
  let animations: FakeAnimation[];

  beforeEach(() => {
    animations = [];
    Object.defineProperty(HTMLCanvasElement.prototype, "animate", {
      configurable: true,
      value: (keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
        const animation = new FakeAnimation(keyframes, options);
        animations.push(animation);
        return animation;
      },
    });
  });

  it("eases the copy out from the next frame, over the time asked, waiting on no frame", () => {
    const overlay = canvas(10, 10);
    expect(snapshotCrossfade(canvas(600, 400), overlay, 140)).toBe(true);

    expect(animations).toHaveLength(1);
    expect(animations[0].keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    expect(animations[0].options).toEqual({ duration: 140, easing: EASE_OUT });
    expect(frameQueue.size).toBe(0);
    // Hidden once the animation lets go of it.
    expect(overlay.style.opacity).toBe("0");
    expect(overlay.style.transition).toBe("none");
  });

  it("lets go of the copy when the animation finishes", () => {
    const overlay = canvas(10, 10);
    snapshotCrossfade(canvas(600, 400), overlay, 140);
    expect(overlay.width).toBe(600);
    expect(crossfading(overlay)).toBe(true);

    animations[0].onfinish?.();
    expect(overlay.width).toBe(0);
    expect(crossfading(overlay)).toBe(false);
  });

  it("stops the animation and lets go of the copy when cancelled", () => {
    const overlay = canvas(10, 10);
    snapshotCrossfade(canvas(600, 400), overlay, 140);
    cancelCrossfade(overlay);

    expect(animations[0].cancelled).toBe(true);
    expect(overlay.width).toBe(0);
    expect(overlay.style.opacity).toBe("0");
    expect(crossfading(overlay)).toBe(false);
  });

  it("keeps a newer fade's copy when an older animation's events come late", () => {
    const overlay = canvas(10, 10);
    snapshotCrossfade(canvas(600, 400), overlay, 140);
    const older = animations[0];
    snapshotCrossfade(canvas(300, 200), overlay, 220);
    expect(older.cancelled).toBe(true);

    older.oncancel?.();
    older.onfinish?.();
    expect(overlay.width).toBe(300);
    expect(crossfading(overlay)).toBe(true);
  });

  it("animates nothing under Reduce motion", () => {
    document.documentElement.classList.add("sl-reduce-motion");
    const overlay = canvas(10, 10);
    expect(snapshotCrossfade(canvas(600, 400), overlay, 140)).toBe(false);
    expect(animations).toEqual([]);
    expect(overlay.width).toBe(0);
  });
});
