// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it } from "vitest";
import { WHOLE_IMAGE, imageSpaceMatrix } from "../geometry";
import type { Mat3 } from "../transform";
import {
  CUT_SPAN,
  DetailAsks,
  GEOMETRY_MARGIN,
  cutBox,
  cutSize,
  detailView,
  gainCovers,
  gainScale,
  gainServes,
  padBox,
  rebuildsSource,
  sourceBox,
  type HeldGain,
} from "./detail-gain";

const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const flat = { region: WHOLE_IMAGE, inverse: IDENTITY };

function expectRect(
  got: { x: number; y: number; w: number; h: number } | null | undefined,
  want: { x: number; y: number; w: number; h: number },
): void {
  if (!got) throw new Error("no rect");
  expect(got.x).toBeCloseTo(want.x, 9);
  expect(got.y).toBeCloseTo(want.y, 9);
  expect(got.w).toBeCloseTo(want.w, 9);
  expect(got.h).toBeCloseTo(want.h, 9);
}

describe("sourceBox: where a window of the view lands in the source", () => {
  it("is the window itself without crop or transform", () => {
    const box = sourceBox({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, flat);
    expectRect(box?.rect, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    expect(box?.area).toBeCloseTo(0.25, 12);
  });

  it("goes through a centred crop's region", () => {
    const geometry = { region: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, inverse: IDENTITY };
    expectRect(sourceBox({ x: 0, y: 0, w: 1, h: 1 }, geometry)?.rect, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    const quarter = sourceBox({ x: 0, y: 0, w: 0.5, h: 0.5 }, geometry);
    expectRect(quarter?.rect, { x: 0.25, y: 0.25, w: 0.25, h: 0.25 });
    expect(quarter?.area).toBeCloseTo(0.0625, 12);
  });

  it("swaps the axes for a 90-degree turn", () => {
    // (x, y) -> (y, 1 - x)
    const turn: Mat3 = [0, 1, 0, -1, 0, 1, 0, 0, 1];
    const box = sourceBox({ x: 0, y: 0, w: 0.5, h: 0.25 }, { region: WHOLE_IMAGE, inverse: turn });
    expectRect(box?.rect, { x: 0, y: 0.5, w: 0.25, h: 0.5 });
    expect(box?.area).toBeCloseTo(0.125, 12);
  });

  it("mirrors a window for a flip", () => {
    const flip: Mat3 = [-1, 0, 1, 0, 1, 0, 0, 0, 1];
    expectRect(sourceBox({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, { region: WHOLE_IMAGE, inverse: flip })?.rect, {
      x: 0.6,
      y: 0.2,
      w: 0.3,
      h: 0.4,
    });
  });

  it("bounds the corners of a window turned by a small straighten angle", () => {
    const theta = (2 * Math.PI) / 180;
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const rot: Mat3 = [c, -s, 0, s, c, 0, 0, 0, 1];
    const inverse = imageSpaceMatrix({ square: rot, normalized: IDENTITY }, 1);
    const box = sourceBox({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, { region: WHOLE_IMAGE, inverse });
    const half = 0.25 * (c + s);
    expectRect(box?.rect, { x: 0.5 - half, y: 0.5 - half, w: 2 * half, h: 2 * half });
    // A turn keeps the footprint's area; only its bounding box grows.
    expect(box?.area).toBeCloseTo(0.25, 9);
  });

  it("divides by w as the program does under a keystone", () => {
    const keystone: Mat3 = [1, 0, 0, 0, 1, 0, 0.5, 0, 1];
    // w = 1 + x / 2: (1, 0) -> (1 / 1.5, 0), (1, 1) -> (1 / 1.5, 1 / 1.5);
    // (0, 0) and (0, 1) stay.
    expectRect(sourceBox({ x: 0, y: 0, w: 1, h: 1 }, { region: WHOLE_IMAGE, inverse: keystone })?.rect, {
      x: 0,
      y: 0,
      w: 1 / 1.5,
      h: 1,
    });
    // (0.5, 0.5) -> (0.4, 0.4), (1, 0.5) -> (1 / 1.5, 1 / 3), (0.5, 1) -> (0.4, 0.8).
    const box = sourceBox({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, { region: WHOLE_IMAGE, inverse: keystone });
    expectRect(box?.rect, { x: 0.4, y: 1 / 3, w: 1 / 1.5 - 0.4, h: 0.8 - 1 / 3 });
  });

  it("follows a window in a corner of a crop", () => {
    const geometry = { region: { x: 0.2, y: 0.2, width: 0.6, height: 0.6 }, inverse: IDENTITY };
    expectRect(sourceBox({ x: 0.75, y: 0.75, w: 0.25, h: 0.25 }, geometry)?.rect, {
      x: 0.65,
      y: 0.65,
      w: 0.15,
      h: 0.15,
    });
  });

  it("clamps to the source, and is null for a window that shows none of it", () => {
    const shift: Mat3 = [1, 0, 0.8, 0, 1, 0, 0, 0, 1];
    expectRect(sourceBox({ x: 0, y: 0, w: 0.5, h: 1 }, { region: WHOLE_IMAGE, inverse: shift })?.rect, {
      x: 0.8,
      y: 0,
      w: 0.2,
      h: 1,
    });
    const away: Mat3 = [1, 0, 2, 0, 1, 0, 0, 0, 1];
    expect(sourceBox({ x: 0, y: 0, w: 1, h: 1 }, { region: WHOLE_IMAGE, inverse: away })).toBeNull();
  });
});

describe("padBox and cutBox", () => {
  it("pads by an absolute margin on every side, clamped", () => {
    expectRect(padBox({ x: 0.9, y: 0.9, w: 0.1, h: 0.1 }, GEOMETRY_MARGIN), { x: 0.87, y: 0.87, w: 0.13, h: 0.13 });
    expectRect(padBox({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, GEOMETRY_MARGIN), { x: 0.37, y: 0.37, w: 0.26, h: 0.26 });
  });

  it("grows a box to 1.5 times its size about its centre, clamped", () => {
    expect(CUT_SPAN).toBe(1.5);
    expectRect(cutBox({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 }), { x: 0.35, y: 0.35, w: 0.3, h: 0.3 });
    expectRect(cutBox({ x: 0.9, y: 0, w: 0.1, h: 0.2 }), { x: 0.875, y: 0, w: 0.125, h: 0.25 });
  });
});

describe("detailView: whether a window wants detail, and how much", () => {
  const base = { width: 1000, height: 500 };
  const native = { width: 2000, height: 1000 };
  const roi = { x: 0.4, y: 0.4, w: 0.1, h: 0.1 };
  const view = (w: number, h: number, warped = false) =>
    detailView({ roi, out: { w, h }, geometry: flat, warped, base, native });

  it("measures the output's density in output pixels per source texel", () => {
    // The window holds 100 x 50 source texels.
    expect(view(200, 100)?.need).toBeCloseTo(2, 12);
  });

  it("never asks for more than the native frame holds", () => {
    expect(view(400, 200)?.need).toBeCloseTo(2, 12);
  });

  it("wants nothing until the output is more than 5% past the source's texels", () => {
    expect(view(100, 50)).toBeNull();
    expect(view(104, 52)).toBeNull();
    expect(view(106, 53)?.need).toBeCloseTo(1.06, 12);
  });

  it("cuts 1.5 times the box, padded only while a geometry stage warps the frame", () => {
    const plain = view(200, 100);
    expectRect(plain?.box, roi);
    expectRect(plain?.cut, { x: 0.375, y: 0.375, w: 0.15, h: 0.15 });
    const warped = view(200, 100, true);
    expectRect(warped?.box, roi);
    expectRect(warped?.cut, cutBox(padBox(roi, GEOMETRY_MARGIN)));
  });

  it("asks for the cut at the view's density over the larger box", () => {
    const v = view(106, 53);
    if (!v) throw new Error("no view");
    // At 1.06 of a native density of 2, over 0.15 of the frame and a pixel more
    // on each side for the cut's snap to whole pixels.
    const size = cutSize(v, base, native, 4096);
    expect(size.outW).toBeCloseTo((0.15 * 2000 + 2) * 0.53, 9);
    expect(size.outH).toBeCloseTo((0.15 * 1000 + 2) * 0.53, 9);
  });

  // The cut snaps outward to whole native pixels and never upsamples, so asking
  // for no more than the box holds at native density would come back downsampled.
  it("asks for every native pixel the snapped box can hold when the view wants native density", () => {
    const v = view(400, 200);
    if (!v) throw new Error("no view");
    const size = cutSize(v, base, native, 4096);
    expect(size.outW).toBeCloseTo(0.15 * 2000 + 2, 9);
    expect(size.outH).toBeCloseTo(0.15 * 1000 + 2, 9);
  });

  it("asks for no more than the texture limit on either axis, keeping the box's aspect", () => {
    const v = view(400, 200);
    if (!v) throw new Error("no view");
    const size = cutSize(v, base, native, 120);
    expect(size.outW).toBeCloseTo(120, 9);
    expect(size.outH).toBeCloseTo((120 * 152) / 302, 9);
    const tall = cutSize({ ...v, cut: { x: 0, y: 0, w: 0.1, h: 0.9 } }, base, native, 120);
    expect(tall.outH).toBeCloseTo(120, 9);
    expect(tall.outW / tall.outH).toBeCloseTo((0.1 * 2000 + 2) / (0.9 * 1000 + 2), 9);
  });

  it("measures density by area, so a turned window needs what an upright one does", () => {
    const turn: Mat3 = [0, 1, 0, -1, 0, 1, 0, 0, 1];
    const square = { width: 1000, height: 1000 };
    const turned = detailView({
      roi,
      out: { w: 200, h: 200 },
      geometry: { region: WHOLE_IMAGE, inverse: turn },
      warped: false,
      base: square,
      native: { width: 4000, height: 4000 },
    });
    expect(turned?.need).toBeCloseTo(2, 12);
  });
});

describe("gainCovers: whether a held gain serves a view", () => {
  const base = { width: 1000, height: 500 };
  const native = { width: 2000, height: 1000 };
  const view = detailView({
    roi: { x: 0.4, y: 0.4, w: 0.1, h: 0.1 },
    out: { w: 200, h: 100 },
    geometry: flat,
    warped: false,
    base,
    native,
  });
  if (!view) throw new Error("no view");
  const held: HeldGain = { epoch: 3, rect: { x: 0.375, y: 0.375, w: 0.15, h: 0.15 }, width: 300, height: 150 };

  it("reads a gain's density as output pixels per source texel", () => {
    expect(gainScale(held, base)).toBeCloseTo(2, 12);
  });

  it("serves the view it was cut for", () => {
    expect(gainCovers(held, view, 3, base, native)).toBe(true);
  });

  it("serves no other source", () => {
    expect(gainCovers(held, view, 4, base, native)).toBe(false);
  });

  it("serves a box that passes its edge by less than half a native pixel, not by more", () => {
    const nudged = (dx: number) => ({ ...view, box: { ...view.box, x: 0.375 - dx / native.width } });
    expect(gainCovers(held, nudged(0.4), 3, base, native)).toBe(true);
    expect(gainCovers(held, nudged(0.6), 3, base, native)).toBe(false);
  });

  it("keeps serving a view zoomed in by up to 10%, or out until it is 1.5 times too dense", () => {
    expect(gainCovers(held, { ...view, need: 2.2 }, 3, base, native)).toBe(true);
    expect(gainCovers(held, { ...view, need: 2.3 }, 3, base, native)).toBe(false);
    expect(gainCovers(held, { ...view, need: 2 / 1.5 }, 3, base, native)).toBe(true);
    expect(gainCovers(held, { ...view, need: 1.3 }, 3, base, native)).toBe(false);
  });
});

describe("gainServes: whether a frame draws with a held gain", () => {
  const base = { width: 1000, height: 500 };
  const held: HeldGain = { epoch: 3, rect: { x: 0.375, y: 0.375, w: 0.15, h: 0.15 }, width: 300, height: 150 };
  const view = (box: { x: number; y: number; w: number; h: number }, need = 2) => ({ box, cut: box, need });

  it("draws a gain that overlaps the window, cut for this source", () => {
    expect(gainServes(held, view({ x: 0.5, y: 0.4, w: 0.1, h: 0.1 }), 3, base)).toBe(true);
    expect(gainServes(held, view({ x: 0.4, y: 0.4, w: 0.1, h: 0.1 }), 4, base)).toBe(false);
  });

  it("draws none over a window it misses", () => {
    expect(gainServes(held, view({ x: 0.53, y: 0.4, w: 0.1, h: 0.1 }), 3, base)).toBe(false);
    expect(gainServes(held, view({ x: 0.4, y: 0.1, w: 0.1, h: 0.2 }), 3, base)).toBe(false);
  });

  it("draws none more than twice as dense as the window needs", () => {
    const box = { x: 0.4, y: 0.4, w: 0.1, h: 0.1 };
    expect(gainServes(held, view(box, 1), 3, base)).toBe(true);
    expect(gainServes(held, view(box, 0.99), 3, base)).toBe(false);
  });
});

describe("DetailAsks: the renderer's detail requests", () => {
  it("numbers each request, higher than the last, across a change of source", () => {
    const asks = new DetailAsks();
    expect(asks.ask("1|a", 1)).toBe(1);
    expect(asks.ask("1|b", 1)).toBe(2);
    asks.reset();
    expect(asks.ask("2|a", 2)).toBe(3);
  });

  it("asks once for a cut while it waits for the answer, and again for another", () => {
    const asks = new DetailAsks();
    expect(asks.ask("1|a", 1)).toBe(1);
    expect(asks.wants("1|a")).toBe(false);
    expect(asks.ask("1|a", 1)).toBeNull();
    expect(asks.ask("1|b", 1)).toBe(2);
  });

  it("takes only the newest request's answer, for the epoch it was asked against", () => {
    const asks = new DetailAsks();
    asks.ask("1|a", 1);
    asks.ask("1|b", 1);
    expect(asks.answer(1, 1)).toBeNull();
    expect(asks.answer(2, 2)).toBeNull();
    expect(asks.answer(2, 1)).toBe("1|b");
    expect(asks.answer(2, 1)).toBeNull();
  });

  it("doesn't ask again for a cut that came to nothing, until the source changes", () => {
    const asks = new DetailAsks();
    asks.ask("1|a", 1);
    const signature = asks.answer(1, 1);
    if (!signature) throw new Error("no answer");
    asks.refuse(signature);
    expect(asks.ask("1|a", 1)).toBeNull();
    expect(asks.ask("1|b", 1)).toBe(2);
    asks.reset();
    expect(asks.ask("1|a", 1)).toBe(3);
  });

  it("forgets the request waiting when the source changes", () => {
    const asks = new DetailAsks();
    asks.ask("1|a", 1);
    asks.reset();
    expect(asks.answer(1, 1)).toBeNull();
  });
});

// A stage that writes the colour ahead of the gain turns it off only while it
// is at work on the photo: an extension merely installed must not cost every
// photo its detail.
describe("rebuildsSource", () => {
  const fixed = { stageId: "ext.ca", passes: [{ iterations: 1 }] };
  const counted = {
    stageId: "ext.denoise",
    passes: [{ iterations: 8, drawCount: { qualifiedKey: "ext.denoise.draws", max: 8, fallback: 0 } }],
  };

  it("is false with no such stage", () => {
    expect(rebuildsSource([], [fixed], { "ext.ca.amount": 1 })).toBe(false);
  });

  it("is false for a stage the photo holds no value of", () => {
    expect(rebuildsSource(["ext.ca"], [fixed], {})).toBe(false);
    expect(rebuildsSource(["ext.ca"], [fixed], { "ext.ca.amount": 0, "ext.other.amount": 5 })).toBe(false);
  });

  it("is true once the photo holds a value of the stage's", () => {
    expect(rebuildsSource(["ext.ca"], [fixed], { "ext.ca.amount": 0.4 })).toBe(true);
    expect(rebuildsSource(["ext.ca"], [fixed], { "ext.ca.on": true })).toBe(true);
  });

  it("follows a counted pass's draws", () => {
    expect(rebuildsSource(["ext.denoise"], [counted], {})).toBe(false);
    expect(rebuildsSource(["ext.denoise"], [counted], { "ext.denoise.threshold": 0.2, "ext.denoise.draws": 0 })).toBe(false);
    expect(rebuildsSource(["ext.denoise"], [counted], { "ext.denoise.draws": 3 })).toBe(true);
  });

  it("counts a default above zero as at work", () => {
    const eager = {
      stageId: "ext.sharpen",
      passes: [{ iterations: 4, drawCount: { qualifiedKey: "ext.sharpen.draws", max: 4, fallback: 2 } }],
    };
    expect(rebuildsSource(["ext.sharpen"], [eager], {})).toBe(true);
  });

  it("goes by the values alone for a stage with no passes", () => {
    expect(rebuildsSource(["ext.inline"], [], {})).toBe(false);
    expect(rebuildsSource(["ext.inline"], [], { "ext.inline.amount": 12 })).toBe(true);
  });

  it("is false while the stage's dormant rule holds, and for a view-only stage", () => {
    expect(rebuildsSource(["ext.ca"], [{ ...fixed, dormant: [] }], { "ext.ca.amount": 1 })).toBe(false);
    expect(rebuildsSource(["ext.ca"], [{ ...fixed, viewOnly: true as const }], { "ext.ca.amount": 1 })).toBe(false);
  });
});
