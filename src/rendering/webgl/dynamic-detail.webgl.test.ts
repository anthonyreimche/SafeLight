// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Dynamic detail: the develop renderer knows the size of the photo's native frame,
// asks for a gain map for a zoomed window (cut here with cutDetailGain, as the
// native frame worker cuts it), and multiplies the window's linear luminance by
// it. The base is the native frame averaged down as a cached preview is, so the
// frame drawn from the native frame itself is what the gain should bring the
// base's back to. Every draw but a live windowed one stays as it was.

import { describe, expect, it } from "vitest";
import type { BrushDab, DevelopParams, RetouchSpot } from "@/catalog/types";
import type { ProcessingStageContribution } from "@/extensions/types";
import { encodeCachedPreview } from "@/raw/cache-encode";
import { lumaHalves } from "@/raw/frame-job";
import { halfBits } from "@/raw/half-float";
import { cutDetailGain, type NativeLuma } from "@/raw/native-frame";
import type { Float16Source } from "@/rendering/source-sample";
import { denoiseBag } from "./builtin-denoise";
import type { WebGLRenderer } from "./renderer";
import {
  builtinStages,
  differing,
  floatImage,
  glHarness,
  identityParams,
  liveFrame,
  trackGlObjects,
  withRenderer,
  type FloatImage,
} from "./webgl.test-support";

const KEY = "photo:0";

/** A native frame, the base a cached preview of it holds, and its luminance. */
interface Scene {
  image: FloatImage;
  base: () => Float16Source;
  luma: () => NativeLuma;
  /** Native luminance with no detail in it: every gain cut from it is exactly 1. */
  flat: () => NativeLuma;
}

/** A gradient under a one-pixel checker, with a little colour noise: detail a
 *  box average takes out. Linear values in about [0.09, 0.9]. */
function scene(width: number, height: number, baseEdge: number): Scene {
  const image = floatImage(width, height, (x, y) => {
    const ramp = 0.12 + 0.5 * (x / width) + 0.1 * (y / height);
    const v = ramp * ((x + y) % 2 === 0 ? 1.25 : 0.75);
    const tint = 1 + 0.08 * (((x * 7 + y * 13) % 3) - 1);
    return [v * 1.05 * tint, v, (v * 0.92) / tint];
  });
  return {
    image,
    base: () => {
      const preview = encodeCachedPreview(image.data, width, height, baseEdge);
      return { kind: "float16", data: preview.data, width: preview.width, height: preview.height, fullWidth: width, fullHeight: height };
    },
    luma: () => ({ data: lumaHalves(image.data), width, height }),
    flat: () => ({ data: new Uint16Array(width * height).fill(halfBits(0.3)), width, height }),
  };
}

// The base at exactly half the native frame's size: 128 x 96 of 256 x 192.
const MAIN = scene(256, 192, 128);

// A window over the middle of MAIN at native 1:1: 64 x 48 native pixels, 32 x 24
// of the base's.
const ROI = { x: 0.25, y: 0.375, w: 0.25, h: 0.25 };
const OUT = { w: 64, h: 48 };

/** Version 2, no sharpening, no noise reduction. */
const NEUTRAL: DevelopParams = identityParams({ processVersion: 2 });

const STAGES = builtinStages(2);

const stage = (id: string, phase: ProcessingStageContribution["phase"]): ProcessingStageContribution => ({
  id,
  name: id,
  phase,
  glsl: "lin = lin * 1.0;",
  uniforms: [],
});

/** An extension's denoiser: it replaces the built-in noise reduction. */
const EXTENSION_NR = stage("ext.denoise", "noise-reduction");
/** An extension's decode stage, as RAW Denoise and Flat Field are. */
const DECODE_STAGE = stage("ext.flatfield", "decode");

const dabs = (count: number): BrushDab[] =>
  Array.from({ length: count }, (_, i) => ({ x: 0.3 + i / 100, y: 0.45, radius: 0.02, erase: false, feather: 0.5 }));

const SPOT: RetouchSpot = {
  id: "spot",
  shape: "brush",
  mode: "heal",
  visible: true,
  dstX: 0.35,
  dstY: 0.45,
  srcX: 0.7,
  srcY: 0.5,
  radius: 0.02,
  feather: 50,
  opacity: 100,
  dabs: dabs(3),
};

function withDeveloper<T>(fn: (r: WebGLRenderer) => T, stages: ProcessingStageContribution[] = STAGES): T {
  return withRenderer({ stages }, (r) => {
    r.keepNativeFrame = true;
    return fn(r);
  });
}

function show(r: WebGLRenderer, s: Scene, params: DevelopParams, roi: typeof ROI, out: typeof OUT): void {
  r.uploadSource(KEY, s.base());
  r.setParams(params);
  r.setContributedParams(denoiseBag(params));
  r.setViewport(roi, out.w, out.h);
}

/** Cuts the gain the renderer asks for from `luma`, as the native frame worker
 *  does, and hands it back. */
function answer(r: WebGLRenderer, luma: NativeLuma): void {
  r.render();
  expect(r.detailWanted).toBe(true);
  const want = r.requestDetail();
  if (!want) throw new Error("no detail request");
  expect(r.detailWanted).toBe(false);
  expect(want.key).toBe(KEY);
  const gain = cutDetailGain(luma, want.rect, want.outW, want.outH, want.baseW, want.baseH);
  expect(r.setDetailGain(want.request, gain)).toBe(true);
}

/** Binds the base under KEY, hands over the native frame's size and answers the
 *  renderer's request with a gain cut from `luma`. */
function cutFor(
  r: WebGLRenderer,
  params: DevelopParams,
  luma: NativeLuma = MAIN.luma(),
  roi = ROI,
  out = OUT,
  s: Scene = MAIN,
): void {
  show(r, s, params, roi, out);
  expect(r.setNativeFrame(KEY, luma)).toBe(true);
  answer(r, luma);
}

/** The base's frame of a window, with no native frame. */
function baseFrame(params: DevelopParams, roi = ROI, out = OUT, stages = STAGES): Frame8 {
  return withDeveloper((r) => {
    show(r, MAIN, params, roi, out);
    return frame8(r);
  }, stages);
}

/** The window drawn from the native frame itself. */
function nativeFrame(params: DevelopParams, s: Scene = MAIN, roi = ROI, out = OUT): Frame8 {
  return withDeveloper((r) => {
    r.uploadSource("native", s.image);
    r.setParams(params);
    r.setContributedParams(denoiseBag(params));
    r.setViewport(roi, out.w, out.h);
    return frame8(r);
  });
}

interface Frame8 {
  data: Uint8Array;
  width: number;
  height: number;
}

function frame8(r: WebGLRenderer): Frame8 {
  const data = liveFrame(r);
  return { data, width: r.bufferWidth, height: r.bufferHeight };
}

const decode = (v: number): number => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const luminanceAt = (f: Frame8, i: number): number =>
  0.2126 * decode(f.data[i * 4]) + 0.7152 * decode(f.data[i * 4 + 1]) + 0.0722 * decode(f.data[i * 4 + 2]);

/** Mean and largest absolute difference in linear luminance between two frames of one size. */
function luminanceError(a: Frame8, b: Frame8): { mean: number; worst: number } {
  expect([a.width, a.height]).toEqual([b.width, b.height]);
  const n = a.width * a.height;
  let sum = 0;
  let worst = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(luminanceAt(a, i) - luminanceAt(b, i));
    sum += d;
    worst = Math.max(worst, d);
  }
  return { mean: sum / n, worst };
}

/** The window with the gain, from the native frame, and with a gain of 1 (the
 *  base at the same density), all at the size the gain draws it. */
function compare(s: Scene, params: DevelopParams, roi: typeof ROI, out: typeof OUT) {
  const detailed = withDeveloper((r) => {
    cutFor(r, params, s.luma(), roi, out, s);
    return frame8(r);
  });
  const drawn = { w: detailed.width, h: detailed.height };
  const native = nativeFrame(params, s, roi, drawn);
  const flat = withDeveloper((r) => {
    cutFor(r, params, s.flat(), roi, out, s);
    return frame8(r);
  });
  const withGain = luminanceError(detailed, native);
  const without = luminanceError(flat, native);
  return { detailed, withGain, without, ratio: without.mean / withGain.mean };
}

function report(label: string, c: ReturnType<typeof compare>): void {
  console.info(
    `[dynamic-detail] ${label}: ${c.detailed.width}x${c.detailed.height}, mean |dY| with gain ${c.withGain.mean.toFixed(5)} ` +
      `(worst ${c.withGain.worst.toFixed(5)}), base only ${c.without.mean.toFixed(5)} (worst ${c.without.worst.toFixed(5)}), ` +
      `ratio ${c.ratio.toFixed(1)}`,
  );
}

describe("dynamic detail brings the native frame's detail back to a zoomed window", () => {
  it("draws the window at native density, close to the native frame's luminance", () => {
    const base = baseFrame(NEUTRAL);
    // The window holds 64 x 48 native pixels; the base alone gives it 32 x 24.
    expect([base.width, base.height]).toEqual([32, 24]);
    const c = compare(MAIN, NEUTRAL, ROI, OUT);
    report("neutral", c);
    expect([c.detailed.width, c.detailed.height]).toEqual([OUT.w, OUT.h]);
    expect(c.withGain.mean).toBeLessThan(0.01);
    expect(c.ratio).toBeGreaterThan(5);
  });

  // The default Colour NR keeps the built-in denoiser in the program, which swaps
  // `lin` for its base-resolution result: the gain comes after it.
  it("still brings the detail back under the built-in denoiser", () => {
    const params = { ...NEUTRAL, colorNR: 25 };
    const c = compare(MAIN, params, ROI, OUT);
    report("colour NR 25", c);
    const passes = withDeveloper((r) => {
      cutFor(r, params);
      frame8(r);
      return r.renderDrawCounts.pass;
    });
    expect(passes).toBeGreaterThan(0);
    // Colour NR keeps luminance, so only the colour shows it did anything.
    const undenoised = withDeveloper((r) => {
      cutFor(r, NEUTRAL);
      return frame8(r);
    });
    expect(differing(c.detailed.data, undenoised.data)).toBeGreaterThan(0);
    expect(c.ratio).toBeGreaterThan(3);
  });

  // Real bases are not half their frames: 250 x 190 averaged to 118 x 90.
  const ODD = scene(250, 190, 118);

  it("lands at a native-to-base ratio that isn't whole", () => {
    // From native pixel (75, 76): a window starting between pixels would have
    // the native frame's own draw average its checker away.
    const c = compare(ODD, NEUTRAL, { x: 0.3, y: 0.4, w: 0.24, h: 0.2 }, { w: 60, h: 38 });
    report("250x190 over 118x90", c);
    expect(c.withGain.mean).toBeLessThan(0.01);
    expect(c.ratio).toBeGreaterThan(5);
  });

  it("lands through a crop and a small straighten angle", () => {
    const params = { ...NEUTRAL, crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8, angle: 0 }, straighten: 2 };
    const c = compare(ODD, params, { x: 0.3, y: 0.35, w: 0.3, h: 0.25 }, { w: 60, h: 38 });
    report("crop and straighten 2", c);
    expect(c.ratio).toBeGreaterThan(3);
  });

  it("lands through a 90-degree turn", () => {
    // A square frame, so the turn keeps it whole.
    const SQUARE = scene(240, 240, 113);
    const c = compare(SQUARE, { ...NEUTRAL, straighten: 90 }, { x: 0.3, y: 0.4, w: 0.25, h: 0.25 }, { w: 60, h: 60 });
    report("turned 90", c);
    expect(c.ratio).toBeGreaterThan(3);
  });
});

describe("dynamic detail is off everywhere else", () => {
  // Transform scale 300 halves the source the view shows, so a window drawn at the
  // base's texels over the cropped view is twice as dense as the source: it wants
  // a gain without the canvas growing, and frames with and without one compare
  // pixel for pixel.
  const SCALED: DevelopParams = { ...NEUTRAL, transform: { ...NEUTRAL.transform, scale: 300 } };
  const SCALED_ROI = { x: 0.5, y: 0.5, w: 0.25, h: 0.25 };
  const SCALED_OUT = { w: 32, h: 24 };

  it("draws a gain of exactly 1 as no gain at all, byte for byte", () => {
    const without = baseFrame(SCALED, SCALED_ROI, SCALED_OUT);
    const flat = withDeveloper((r) => {
      cutFor(r, SCALED, MAIN.flat(), SCALED_ROI, SCALED_OUT);
      return frame8(r);
    });
    expect([flat.width, flat.height]).toEqual([without.width, without.height]);
    expect(differing(flat.data, without.data)).toBe(0);
  });

  it("leaves pixels outside the gain's rect as the base draws them", () => {
    // Panned left after the cut: most of the window lies left of the gain's rect,
    // which the next cut would cover.
    const panned = { ...SCALED_ROI, x: 0.4 };
    const without = baseFrame(SCALED, panned, SCALED_OUT);
    const shown = withDeveloper((r) => {
      cutFor(r, SCALED, MAIN.luma(), SCALED_ROI, SCALED_OUT);
      r.setViewport(panned, SCALED_OUT.w, SCALED_OUT.h);
      const f = frame8(r);
      expect(r.detailWanted).toBe(true);
      return f;
    });
    const columnDiffers = (x: number) => {
      let n = 0;
      for (let y = 0; y < shown.height; y++) {
        const i = (y * shown.width + x) * 4;
        for (let c = 0; c < 3; c++) if (shown.data[i + c] !== without.data[i + c]) n++;
      }
      return n;
    };
    // Column 2 reads source x of about 0.460, left of the rect (from 0.469);
    // column 28 about 0.561, inside it.
    expect(columnDiffers(2)).toBe(0);
    expect(columnDiffers(28)).toBeGreaterThan(0);
  });

  it("draws no gain over a window panned clear of it, at the base's size", () => {
    const panned = { ...SCALED_ROI, x: 0 };
    const without = baseFrame(NEUTRAL, panned, OUT);
    const shown = withDeveloper((r) => {
      cutFor(r, NEUTRAL, MAIN.luma(), SCALED_ROI, OUT);
      r.setViewport(panned, OUT.w, OUT.h);
      return frame8(r);
    });
    expect([shown.width, shown.height]).toEqual([without.width, without.height]);
    expect(differing(shown.data, without.data)).toBe(0);
  });

  it("measures the whole frame, the histogram, a float capture and a probe as without a native frame", () => {
    const read = (r: WebGLRenderer) => {
      const windowed = frame8(r);
      const histogram = r.computeHistogram(true);
      const float = r.readFloatFrame("output");
      const probe = r.probe(0.5, 0.5, "output");
      r.setViewport(null);
      const whole = frame8(r);
      return { windowed, histogram, float, probe, whole };
    };
    const plain = withDeveloper((r) => {
      show(r, MAIN, SCALED, SCALED_ROI, SCALED_OUT);
      return read(r);
    });
    const held = withDeveloper((r) => {
      cutFor(r, SCALED, MAIN.luma(), SCALED_ROI, SCALED_OUT);
      return read(r);
    });
    // The live window does differ: the gain is on there.
    expect(differing(held.windowed.data, plain.windowed.data)).toBeGreaterThan(0);
    expect([...held.histogram.luma]).toEqual([...plain.histogram.luma]);
    expect([...(held.histogram.extended?.luma ?? [])]).toEqual([...(plain.histogram.extended?.luma ?? [])]);
    if (!held.float || !plain.float) throw new Error("no float frame");
    expect([held.float.width, held.float.height]).toEqual([plain.float.width, plain.float.height]);
    expect(differing(held.float.data, plain.float.data)).toBe(0);
    expect(held.probe).toEqual(plain.probe);
    expect(differing(held.whole.data, plain.whole.data)).toBe(0);
  });

  it("measures as without a gain right after a live frame the gain made denser", () => {
    const read = (r: WebGLRenderer) => {
      const live = frame8(r);
      return {
        size: [live.width, live.height],
        histogram: r.computeHistogram(true),
        float: r.readFloatFrame("output"),
        probe: r.probe(0.3, 0.6, "output"),
      };
    };
    const plain = withDeveloper((r) => {
      show(r, MAIN, NEUTRAL, ROI, OUT);
      return read(r);
    });
    const held = withDeveloper((r) => {
      cutFor(r, NEUTRAL);
      return read(r);
    });
    expect(plain.size).toEqual([32, 24]);
    expect(held.size).toEqual([64, 48]);
    expect([...held.histogram.luma]).toEqual([...plain.histogram.luma]);
    if (!held.float || !plain.float) throw new Error("no float frame");
    expect([held.float.width, held.float.height]).toEqual([32, 24]);
    expect(differing(held.float.data, plain.float.data)).toBe(0);
    expect(held.probe).toEqual(plain.probe);
  });

  // An extension stage is at work once the photo holds a value of its own.
  const atWork = (r: WebGLRenderer, added: ProcessingStageContribution): void => {
    r.setStages([...STAGES, added]);
    r.setContributedParams({ ...denoiseBag(SCALED), [`${added.id}.amount`]: 40 });
  };
  const gated: [string, (r: WebGLRenderer) => void, DevelopParams, ProcessingStageContribution[]][] = [
    ["a retouch spot", (r) => r.setParams({ ...SCALED, retouch: [SPOT] }), { ...SCALED, retouch: [SPOT] }, STAGES],
    ["an extension's denoiser at work", (r) => atWork(r, EXTENSION_NR), SCALED, [...STAGES, EXTENSION_NR]],
    ["an extension's decode stage at work", (r) => atWork(r, DECODE_STAGE), SCALED, [...STAGES, DECODE_STAGE]],
    ["a version 1 photo", (r) => r.setParams({ ...SCALED, processVersion: 1 }), { ...SCALED, processVersion: 1 }, STAGES],
  ];
  for (const [label, turnOn, params, stages] of gated) {
    it(`draws the base alone under ${label}, with a gain held`, () => {
      const without = baseFrame(params, SCALED_ROI, SCALED_OUT, stages);
      const shown = withDeveloper((r) => {
        cutFor(r, SCALED, MAIN.luma(), SCALED_ROI, SCALED_OUT);
        turnOn(r);
        const f = frame8(r);
        expect(r.detailWanted).toBe(false);
        expect(r.requestDetail()).toBeNull();
        return f;
      });
      expect([shown.width, shown.height]).toEqual([without.width, without.height]);
      expect(differing(shown.data, without.data)).toBe(0);
    });
  }

  // Installed is not at work: a photo that holds no value of the stage's keeps
  // its detail, or every photo would lose it to an extension it never used.
  for (const [label, added] of [
    ["denoiser", EXTENSION_NR],
    ["decode stage", DECODE_STAGE],
  ] as const) {
    it(`keeps the gain while an extension's ${label} is installed but untouched`, () => {
      const stages = [...STAGES, added];
      const without = baseFrame(NEUTRAL, ROI, OUT, stages);
      const shown = withDeveloper((r) => {
        cutFor(r, NEUTRAL);
        r.setStages(stages);
        return frame8(r);
      });
      expect([shown.width, shown.height]).toEqual([OUT.w, OUT.h]);
      expect([without.width, without.height]).not.toEqual([OUT.w, OUT.h]);
    });
  }
});

describe("detail requests", () => {
  function asking(r: WebGLRenderer) {
    show(r, MAIN, NEUTRAL, ROI, OUT);
    expect(r.setNativeFrame(KEY, MAIN.luma())).toBe(true);
    r.render();
    const want = r.requestDetail();
    if (!want) throw new Error("no detail request");
    return want;
  }

  it("asks once for a view while it waits for the answer, and again once the view moves", () => {
    withDeveloper((r) => {
      const first = asking(r);
      r.render();
      expect(r.detailWanted).toBe(false);
      expect(r.requestDetail()).toBeNull();
      r.setViewport({ ...ROI, x: 0.3 }, OUT.w, OUT.h);
      r.render();
      expect(r.detailWanted).toBe(true);
      const second = r.requestDetail();
      expect(second?.request).toBeGreaterThan(first.request);
      // The older answer goes unheard.
      expect(r.setDetailGain(first.request, cutDetailGain(MAIN.luma(), first.rect, first.outW, first.outH, first.baseW, first.baseH))).toBe(false);
    });
  });

  it("hears no answer asked against a source drawn no longer", () => {
    withDeveloper((r) => {
      const want = asking(r);
      expect(r.bindSource(KEY)).toBe(true);
      expect(r.setDetailGain(want.request, cutDetailGain(MAIN.luma(), want.rect, want.outW, want.outH, want.baseW, want.baseH))).toBe(false);
    });
  });

  it("doesn't ask again for a view whose cut came to nothing", () => {
    withDeveloper((r) => {
      const want = asking(r);
      expect(r.setDetailGain(want.request, null)).toBe(false);
      r.render();
      expect(r.detailWanted).toBe(false);
      expect(r.requestDetail()).toBeNull();
    });
  });

  it("asks for a cut no larger than the texture limit", () => {
    withDeveloper((r) => {
      const want = asking(r);
      const max = glHarness().gl.getParameter(glHarness().gl.MAX_TEXTURE_SIZE);
      expect(want.outW).toBeLessThanOrEqual(max);
      expect(want.outH).toBeLessThanOrEqual(max);
      // Every native pixel of the 1.5x cut box, a pixel more each side for its snap.
      expect(want.outW).toBeCloseTo(98, 6);
      expect(want.outH).toBeCloseTo(74, 6);
    });
  });
});

describe("the native frame and its gain", () => {
  const size = (width: number, height: number) => ({ width, height });

  it("are kept only for the bound source's key and a frame the source is the box-averaged copy of", () => {
    withDeveloper((r) => {
      r.uploadSource(KEY, MAIN.base());
      expect(r.setNativeFrame("photo:1", size(256, 192))).toBe(false);
      expect(r.setNativeFrame(KEY, size(128, 96))).toBe(false);
      expect(r.setNativeFrame(KEY, size(256.5, 192))).toBe(false);
      // The base is 128 x 96: a frame averages down to it within a pixel on each axis.
      expect(r.setNativeFrame(KEY, size(256, 194))).toBe(true);
      expect(r.setNativeFrame(KEY, size(256, 196))).toBe(false);
      expect(r.setNativeFrame(KEY, size(258, 192))).toBe(true);
      expect(r.setNativeFrame(KEY, size(262, 192))).toBe(false);
      expect(r.hasNativeFrame).toBe(false);
      expect(r.setNativeFrame(KEY, size(256, 192))).toBe(true);
      expect(r.hasNativeFrame).toBe(true);
      // A refused frame takes the one held with it.
      expect(r.setNativeFrame("photo:1", size(256, 192))).toBe(false);
      expect(r.hasNativeFrame).toBe(false);
    });
  });

  it("are not kept by a renderer that doesn't keep them", () => {
    withRenderer({ stages: STAGES }, (r) => {
      r.uploadSource(KEY, MAIN.base());
      expect(r.setNativeFrame(KEY, size(256, 192))).toBe(false);
    });
  });

  it("are not kept for a source set without a key, or a fallback preview", () => {
    withDeveloper((r) => {
      r.setImage(MAIN.base());
      expect(r.setNativeFrame(KEY, size(256, 192))).toBe(false);
      r.uploadSource(KEY, { ...MAIN.image, data: MAIN.image.data.slice() }, 128, true);
      expect(r.setNativeFrame(KEY, size(256, 192))).toBe(false);
    });
  });

  it("go when another source is bound, and stay through a neighbour's prefetch", () => {
    const { gl } = glHarness();
    withDeveloper((r) => {
      cutFor(r, NEUTRAL);
      const tally = trackGlObjects(gl);
      try {
        r.uploadSource("photo:1", MAIN.base(), undefined, false, false);
        expect(r.hasNativeFrame).toBe(true);
        r.render();
        expect(r.detailWanted).toBe(false);
        const live = tally.live.texture;
        expect(r.bindSource("photo:1")).toBe(true);
        expect(r.hasNativeFrame).toBe(false);
        expect(tally.live.texture).toBe(live - 1);
        r.render();
        expect(r.detailWanted).toBe(false);
      } finally {
        tally.restore();
      }
    });
  });

  it("keep the frame when the same source is bound again, which needs a new cut", () => {
    withDeveloper((r) => {
      cutFor(r, NEUTRAL);
      expect(r.bindSource(KEY)).toBe(true);
      expect(r.hasNativeFrame).toBe(true);
      answer(r, MAIN.luma());
    });
  });

  it("go with a new image, and when let go of", () => {
    withDeveloper((r) => {
      cutFor(r, NEUTRAL);
      r.setImage(MAIN.base());
      expect(r.hasNativeFrame).toBe(false);
      cutFor(r, NEUTRAL);
      r.clearNativeFrame();
      expect(r.hasNativeFrame).toBe(false);
      r.render();
      expect(r.detailWanted).toBe(false);
    });
  });

  it("leave the unpack alignment and the texture binding as they were", () => {
    const { gl } = glHarness();
    withDeveloper((r) => {
      show(r, MAIN, NEUTRAL, ROI, OUT);
      r.setNativeFrame(KEY, MAIN.luma());
      r.render();
      const want = r.requestDetail();
      if (!want) throw new Error("no detail request");
      const gain = cutDetailGain(MAIN.luma(), want.rect, want.outW, want.outH, want.baseW, want.baseH);
      const bound = gl.getParameter(gl.TEXTURE_BINDING_2D);
      const alignment = gl.getParameter(gl.UNPACK_ALIGNMENT);
      expect(r.setDetailGain(want.request, gain)).toBe(true);
      expect(gl.getParameter(gl.TEXTURE_BINDING_2D)).toBe(bound);
      expect(gl.getParameter(gl.UNPACK_ALIGNMENT)).toBe(alignment);
    });
  });

  it("leave no texture behind when the upload throws", () => {
    const { gl } = glHarness();
    withDeveloper((r) => {
      show(r, MAIN, NEUTRAL, ROI, OUT);
      r.setNativeFrame(KEY, MAIN.luma());
      r.render();
      const want = r.requestDetail();
      if (!want) throw new Error("no detail request");
      const gain = cutDetailGain(MAIN.luma(), want.rect, want.outW, want.outH, want.baseW, want.baseH);
      const tally = trackGlObjects(gl);
      const texImage2D = gl.texImage2D;
      gl.texImage2D = () => {
        throw new Error("lost");
      };
      try {
        expect(() => r.setDetailGain(want.request, gain)).toThrow("lost");
      } finally {
        gl.texImage2D = texImage2D;
        tally.restore();
      }
      expect(tally.live.texture).toBe(0);
    });
  });

  it("are freed with the renderer", () => {
    const { gl } = glHarness();
    const tally = trackGlObjects(gl);
    try {
      withDeveloper((r) => {
        cutFor(r, NEUTRAL);
        expect(tally.live.texture).toBeGreaterThan(0);
      });
      expect(tally.live.texture).toBe(0);
    } finally {
      tally.restore();
    }
  });
});
