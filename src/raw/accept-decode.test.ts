// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What makes a full RAW decode usable and cacheable. Develop and the background
// pre-decode share this ruling, so a bad frame is never remembered by either.
// The image decoder and the WebGL readback are faked: the preview is a flat
// colour, which keeps the arithmetic checkable by hand.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acceptDecode, compareBalance } from "./accept-decode";

const h = vi.hoisted(() => ({
  /** The 8-bit sRGB colour the faked preview sample reads back as. */
  previewRgb: [128, 128, 128] as [number, number, number],
  /** Whether the image decoder can sample the preview. */
  samplable: true,
  /** Whether a WebGL2 context can be had for the readback. */
  webgl: true,
  /** Every sample request, as [resizeWidth, resizeHeight, resizeQuality]. */
  samples: [] as [number | undefined, number | undefined, string | undefined][],
  closedSamples: 0,
  lostContexts: 0,
}));

const preview = new Blob(["jpeg"], { type: "image/jpeg" });

function readback(): Record<string, unknown> {
  const noop = (): void => {};
  return {
    TEXTURE_2D: 1,
    TEXTURE_MIN_FILTER: 2,
    TEXTURE_MAG_FILTER: 3,
    NEAREST: 4,
    RGBA: 5,
    UNSIGNED_BYTE: 6,
    FRAMEBUFFER: 7,
    COLOR_ATTACHMENT0: 8,
    createTexture: () => ({}),
    createFramebuffer: () => ({}),
    bindTexture: noop,
    bindFramebuffer: noop,
    texParameteri: noop,
    texImage2D: noop,
    framebufferTexture2D: noop,
    deleteTexture: noop,
    deleteFramebuffer: noop,
    readPixels: (
      _x: number,
      _y: number,
      _w: number,
      _h: number,
      _format: number,
      _type: number,
      pixels: Uint8Array,
    ) => {
      for (let i = 0; i < pixels.length; i += 4) {
        pixels.set([...h.previewRgb, 255], i);
      }
    },
    getExtension: () => ({
      loseContext: () => {
        h.lostContexts++;
      },
    }),
  };
}

class FakeCanvas {
  getContext(kind: string): Record<string, unknown> | null {
    return kind === "webgl2" && h.webgl ? readback() : null;
  }
}

beforeEach(() => {
  h.previewRgb = [128, 128, 128];
  h.samplable = true;
  h.webgl = true;
  h.samples = [];
  h.closedSamples = 0;
  h.lostContexts = 0;
  vi.stubGlobal("OffscreenCanvas", FakeCanvas);
  vi.stubGlobal("createImageBitmap", async (_src: Blob, opts?: ImageBitmapOptions) => {
    h.samples.push([opts?.resizeWidth, opts?.resizeHeight, opts?.resizeQuality]);
    if (!h.samplable) throw new Error("no image decoder");
    return {
      width: 64,
      height: 64,
      close() {
        h.closedSamples++;
      },
    };
  });
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const toLinear = (v8: number): number => {
  const v = v8 / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};

/** A flat 8x8 linear decode of one colour. */
function flatLinear(rgb: [number, number, number]): {
  data: Float32Array;
  width: number;
  height: number;
} {
  const data = new Float32Array(8 * 8 * 4);
  for (let i = 0; i < data.length; i += 4) data.set([...rgb, 1], i);
  return { data, width: 8, height: 8 };
}

/** A flat decode whose channels are the linear values of `rgb8` times `gain`. */
function flatDecode(
  rgb8: [number, number, number],
  gain: [number, number, number] = [1, 1, 1],
): { data: Float32Array; width: number; height: number } {
  return flatLinear([
    toLinear(rgb8[0]) * gain[0],
    toLinear(rgb8[1]) * gain[1],
    toLinear(rgb8[2]) * gain[2],
  ]);
}

describe("acceptDecode without an embedded preview", () => {
  it("trusts the decode and lets it be cached", async () => {
    expect(await acceptDecode({}, flatDecode([128, 128, 128]), null)).toEqual({
      use: true,
      cache: true,
    });
    expect(h.samples).toEqual([]);
  });

  it("uses a suspicious decode but never caches it", async () => {
    expect(
      await acceptDecode({ suspicious: true }, flatDecode([128, 128, 128]), null),
    ).toEqual({ use: true, cache: false });
  });
});

describe("acceptDecode against the embedded preview", () => {
  beforeEach(() => {
    h.previewRgb = [200, 120, 60];
  });

  it("uses and caches a decode whose colours follow the preview", async () => {
    const verdict = await acceptDecode({}, flatDecode([200, 120, 60]), preview);
    expect(verdict).toEqual({ use: true, cache: true });
  });

  it("allows a warm or cool shot that stays inside the 2x band", async () => {
    const verdict = await acceptDecode(
      {},
      flatDecode([200, 120, 60], [1.6, 1, 0.7]),
      preview,
    );
    expect(verdict).toEqual({ use: true, cache: true });
  });

  it("rejects a decode with a red/green balance 2x or more off the preview", async () => {
    const verdict = await acceptDecode(
      {},
      flatDecode([200, 120, 60], [2.5, 1, 1]),
      preview,
    );
    expect(verdict).toEqual({ use: false, cache: false });
  });

  it("rejects a decode with a blue/green balance 2x or more off the preview", async () => {
    const verdict = await acceptDecode(
      {},
      flatDecode([200, 120, 60], [1, 1, 0.4]),
      preview,
    );
    expect(verdict).toEqual({ use: false, cache: false });
  });

  it("rejects a wrong-colour decode whether or not it was flagged suspicious", async () => {
    const wrong = flatDecode([200, 120, 60], [3, 1, 1]);
    expect(await acceptDecode({ suspicious: true }, wrong, preview)).toEqual({
      use: false,
      cache: false,
    });
  });

  it("uses a suspicious decode with the right colours but does not cache it", async () => {
    const verdict = await acceptDecode(
      { suspicious: true },
      flatDecode([200, 120, 60]),
      preview,
    );
    expect(verdict).toEqual({ use: true, cache: false });
  });

  it("compares in linear light, not in the preview's 8-bit encoding", async () => {
    // Encoded 200 against 100 is 2x; in linear light it is about 4.5x.
    h.previewRgb = [200, 100, 100];

    expect(await acceptDecode({}, flatDecode([200, 100, 100]), preview)).toEqual({
      use: true,
      cache: true,
    });
    expect(await acceptDecode({}, flatLinear([200 / 255, 100 / 255, 100 / 255]), preview)).toEqual({
      use: false,
      cache: false,
    });
  });

  it("samples the preview at 64 px and frees the sample and its GL context", async () => {
    await acceptDecode({}, flatDecode([200, 120, 60]), preview);

    expect(h.samples).toEqual([[64, 64, "pixelated"]]);
    expect(h.closedSamples).toBe(1);
    expect(h.lostContexts).toBe(1);
  });
});

describe("acceptDecode when the colour check can't run", () => {
  it("trusts the decode when the preview can't be decoded", async () => {
    h.samplable = false;
    const verdict = await acceptDecode({}, flatDecode([10, 200, 10]), preview);
    expect(verdict).toEqual({ use: true, cache: true });
  });

  it("trusts the decode when WebGL2 is unavailable for the readback", async () => {
    h.webgl = false;
    const verdict = await acceptDecode({}, flatDecode([10, 200, 10]), preview);
    expect(verdict).toEqual({ use: true, cache: true });
  });

  it("still keeps a suspicious decode out of the cache", async () => {
    h.samplable = false;
    const verdict = await acceptDecode({ suspicious: true }, flatDecode([10, 200, 10]), preview);
    expect(verdict).toEqual({ use: true, cache: false });
  });

  // Some Mesa drivers read every pixel back as zero, which says nothing about
  // the decode; rejecting it would make the verdict depend on the machine.
  it("trusts the decode when the preview reads back black", async () => {
    h.previewRgb = [0, 0, 0];
    const verdict = await acceptDecode({}, flatDecode([10, 200, 10]), preview);
    expect(verdict).toEqual({ use: true, cache: true });
  });

  it("trusts the decode when one of the preview's channels reads back empty", async () => {
    h.previewRgb = [200, 120, 0];
    const verdict = await acceptDecode({}, flatDecode([200, 120, 40]), preview);
    expect(verdict).toEqual({ use: true, cache: true });
  });
});

describe("compareBalance", () => {
  const grey = { r: 0.5, g: 0.5, b: 0.5 };

  it("agrees when both images have the same channel balance", () => {
    expect(compareBalance(grey, grey)).toMatchObject({ rgFactor: 1, bgFactor: 1, ok: true });
  });

  it("ignores overall brightness; only the ratios to green count", () => {
    expect(compareBalance({ r: 0.1, g: 0.1, b: 0.1 }, { r: 0.8, g: 0.8, b: 0.8 }).ok).toBe(true);
  });

  it("accepts a factor just under 2 and rejects exactly 2", () => {
    expect(compareBalance({ r: 0.99, g: 0.5, b: 0.5 }, grey).ok).toBe(true);
    expect(compareBalance({ r: 1, g: 0.5, b: 0.5 }, grey)).toMatchObject({
      rgFactor: 2,
      ok: false,
    });
  });

  it("measures the gap the same way round", () => {
    expect(compareBalance({ r: 0.25, g: 0.5, b: 0.5 }, grey)).toMatchObject({
      rgFactor: 2,
      ok: false,
    });
    expect(compareBalance(grey, { r: 1, g: 0.5, b: 0.5 })).toMatchObject({
      rgFactor: 2,
      ok: false,
    });
  });

  it("rejects when only the blue balance is off", () => {
    expect(compareBalance({ r: 0.5, g: 0.5, b: 1.2 }, grey)).toMatchObject({
      rgFactor: 1,
      bgFactor: 2.4,
      ok: false,
    });
  });

  it("rejects a decode with no green at all", () => {
    expect(compareBalance({ r: 0.5, g: 0, b: 0.5 }, grey).ok).toBe(false);
  });

  it("finds nothing to compare against in an empty or unreadable preview", () => {
    expect(compareBalance(grey, { r: 0, g: 0, b: 0 }).ok).toBe(true);
    expect(compareBalance(grey, { r: 0.5, g: 0.5, b: 0 }).ok).toBe(true);
    expect(compareBalance(grey, { r: Number.NaN, g: 0.5, b: 0.5 }).ok).toBe(true);
    expect(compareBalance(grey, { r: Infinity, g: 0.5, b: 0.5 }).ok).toBe(true);
  });
});
