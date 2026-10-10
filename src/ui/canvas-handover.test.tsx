// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Develop builds a new view, with a new canvas, for every photo. The picture the
// view going away showed is handed to the next one, which shows it where it was,
// at its own size, until its own first picture or 150 ms. Views of one switch go
// and come in one React commit; a picture no view takes by the end of it is let go.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HANDOVER_MS,
  endHandover,
  leavePicture,
  releaseHandover,
  takeHandover,
} from "./canvas-handover";

let copies: { into: HTMLCanvasElement; image: unknown }[];
let canvasContext: PropertyDescriptor | undefined;

function canvas(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return c;
}

/** A view's handover canvas, as DevelopCanvas renders it: hidden until it takes one. */
function handover(): HTMLCanvasElement {
  const c = canvas(300, 150);
  c.style.display = "none";
  return c;
}

const shows = (c: HTMLCanvasElement) => c.style.display !== "none" && c.width > 0;

const RECT = { x: 10, y: 20, w: 300, h: 200 };

beforeEach(() => {
  copies = [];
  canvasContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: function getContext(this: HTMLCanvasElement) {
      const into = this;
      const drawImage = (image: unknown) => {
        // As a browser does: a canvas with no pixels can't be drawn.
        if (image instanceof HTMLCanvasElement && (!image.width || !image.height)) {
          throw new DOMException("The image argument is a canvas with no pixels", "InvalidStateError");
        }
        copies.push({ into, image });
      };
      return { drawImage };
    },
  });
});

afterEach(() => {
  endHandover();
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (canvasContext) {
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", canvasContext);
  }
});

describe("takeHandover", () => {
  it("shows nothing when no picture was left", () => {
    const into = handover();
    expect(takeHandover(into)).toBe(false);
    expect(shows(into)).toBe(false);
  });

  it("draws the picture left at its own size, where it showed", () => {
    const left = canvas(600, 400);
    leavePicture({ canvas: left, rect: RECT, mat: 0 });
    const into = handover();

    expect(takeHandover(into)).toBe(true);

    expect(copies).toEqual([{ into, image: left }]);
    expect(into.width).toBe(600);
    expect(into.height).toBe(400);
    expect(into.style.display).toBe("block");
    expect(into.style.left).toBe("10px");
    expect(into.style.top).toBe("20px");
    expect(into.style.width).toBe("300px");
    expect(into.style.height).toBe("200px");
    expect(into.style.boxShadow).toBe("none");
  });

  it("frames it in the colour-assessment mat it had", () => {
    leavePicture({ canvas: canvas(600, 400), rect: RECT, mat: 27 });
    const into = handover();
    takeHandover(into);
    expect(into.style.boxShadow).toMatch(/^0(px)? 0(px)? 0(px)? 27px/);
  });

  it("is not shown once 150 ms have gone since it was left", () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    leavePicture({ canvas: canvas(600, 400), rect: RECT, mat: 0 });
    now += HANDOVER_MS + 1;
    const into = handover();
    expect(takeHandover(into)).toBe(false);
    expect(shows(into)).toBe(false);
  });

  // The next view takes it in a layout effect, where a throw would take Develop down.
  it.each([
    [0, 400],
    [600, 0],
  ])("shows nothing, and lets go, of a %i×%i picture", (width, height) => {
    leavePicture({ canvas: canvas(width, height), rect: RECT, mat: 0 });
    const into = handover();
    expect(takeHandover(into)).toBe(false);
    expect(shows(into)).toBe(false);
    expect(copies).toEqual([]);
    expect(takeHandover(handover())).toBe(false);
  });

  it("is shown again by the view that took it when React runs its effects twice", () => {
    leavePicture({ canvas: canvas(600, 400), rect: RECT, mat: 0 });
    const into = handover();
    takeHandover(into);
    releaseHandover(into);
    expect(takeHandover(into)).toBe(true);
    expect(shows(into)).toBe(true);
  });
});

describe("endHandover", () => {
  it("hides the picture and lets go of it", () => {
    leavePicture({ canvas: canvas(600, 400), rect: RECT, mat: 27 });
    const into = handover();
    takeHandover(into);

    endHandover();

    expect(into.style.display).toBe("none");
    expect(into.width).toBe(0);
    expect(into.height).toBe(0);
    expect(takeHandover(handover())).toBe(false);
  });

  it("happens by itself 150 ms after the picture was left", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    leavePicture({ canvas: canvas(600, 400), rect: RECT, mat: 0 });
    const into = handover();
    takeHandover(into);

    vi.advanceTimersByTime(HANDOVER_MS - 1);
    expect(shows(into)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(shows(into)).toBe(false);
    expect(into.width).toBe(0);
  });
});

describe("a picture no view takes", () => {
  // Develop closed, or the project did: no view comes in the same commit.
  it("is let go once the commit that left it is done", async () => {
    leavePicture({ canvas: canvas(600, 400), rect: RECT, mat: 0 });
    await Promise.resolve();
    expect(takeHandover(handover())).toBe(false);
  });

  it("is kept while a view shows it", async () => {
    leavePicture({ canvas: canvas(600, 400), rect: RECT, mat: 0 });
    const into = handover();
    takeHandover(into);
    await Promise.resolve();
    expect(shows(into)).toBe(true);
  });
});

// Holding an arrow key: each view goes before its own first picture, and the next
// shows what the last view with a picture left, until the cap. Only one shows.
describe("a quick run of switches", () => {
  it("passes the same picture on from view to view", async () => {
    const a = canvas(600, 400);
    leavePicture({ canvas: a, rect: RECT, mat: 0 });
    const b = handover();
    takeHandover(b);

    releaseHandover(b);
    const c = handover();
    expect(takeHandover(c)).toBe(true);
    await Promise.resolve();

    expect(shows(b)).toBe(false);
    expect(b.width).toBe(0);
    expect(shows(c)).toBe(true);
    expect(copies.at(-1)).toEqual({ into: c, image: a });
  });

  it("shows the newest picture left, never two", () => {
    leavePicture({ canvas: canvas(600, 400), rect: RECT, mat: 0 });
    const b = handover();
    takeHandover(b);

    const bPicture = canvas(400, 600);
    releaseHandover(b);
    leavePicture({ canvas: bPicture, rect: { x: 0, y: 0, w: 200, h: 300 }, mat: 0 });
    const c = handover();
    takeHandover(c);

    expect(shows(b)).toBe(false);
    expect(copies.at(-1)).toEqual({ into: c, image: bPicture });
    expect(c.width).toBe(400);
  });
});
