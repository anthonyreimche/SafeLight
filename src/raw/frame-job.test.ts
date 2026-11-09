// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The per-pixel work of a RAW decode, run off the main thread: libraw's samples
// to a linear sRGB float frame, turned upright when asked, with the cache entry
// built from that frame. Each case compares against the steps it replaced.

import { describe, expect, it } from "vitest";
import { rotateFloatRGBA } from "@/catalog/orient";
import { encodeCacheEntry } from "./cache-encode";
import { SRGB_FROM_ACES, buildFrame, handleFrameRequest, linearOfCode, toSrgb8, type FrameJob } from "./frame-job";

/** The conversion as the adapter ran it inline, before it moved off the main thread. */
function inlineFrame(job: FrameJob): Float32Array {
  const { pixels, width, height, stride, gain } = job;
  const n = width * height;
  const table = linearOfCode();
  const step = pixels instanceof Uint16Array ? 1 : 257;
  const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = SRGB_FROM_ACES;
  const data = new Float32Array(n * 4);
  for (let i = 0, o = 0, s = 0; i < n; i++, o += 4, s += stride) {
    const r = table[pixels[s] * step];
    if (stride >= 3) {
      const g = table[pixels[s + 1] * step];
      const b = table[pixels[s + 2] * step];
      data[o] = (m0 * r + m1 * g + m2 * b) * gain;
      data[o + 1] = (m3 * r + m4 * g + m5 * b) * gain;
      data[o + 2] = (m6 * r + m7 * g + m8 * b) * gain;
    } else {
      data[o] = data[o + 1] = data[o + 2] = r * gain;
    }
    data[o + 3] = 1;
  }
  return data;
}

function noise(count: number, max: number): number[] {
  let seed = 12345;
  return Array.from({ length: count }, () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % (max + 1);
  });
}

function job(over: Partial<FrameJob> = {}): FrameJob {
  const { width = 5, height = 3, stride = 3 } = over;
  const bits16 = !(over.pixels instanceof Uint8Array);
  const pixels = over.pixels ?? Uint16Array.from(noise(width * height * stride, bits16 ? 65535 : 255));
  return { pixels, width, height, stride, gain: 1.3, turn: 0, foveon: false, ...over };
}

function built(j: FrameJob) {
  const out = buildFrame(j);
  if ("rejected" in out) throw new Error(`rejected: ${out.rejected}`);
  return out;
}

describe("buildFrame", () => {
  for (const stride of [4, 3, 1]) {
    for (const bits of [16, 8]) {
      it(`matches the inline conversion from ${bits}-bit, ${stride}-channel samples`, () => {
        const pixels = bits === 16
          ? Uint16Array.from(noise(15 * stride, 65535))
          : Uint8Array.from(noise(15 * stride, 255));
        const j = job({ pixels, stride });

        const out = built(j);

        expect(out.data).toEqual(inlineFrame(j));
        expect([out.width, out.height]).toEqual([5, 3]);
      });
    }
  }

  for (const turn of [90, 180, 270]) {
    it(`turns the frame ${turn} degrees exactly as rotating the finished frame does`, () => {
      const j = job({ turn });
      const rotated = rotateFloatRGBA(inlineFrame(j), j.width, j.height, turn);

      const out = built(j);

      expect(out.data).toEqual(rotated.data);
      expect([out.width, out.height]).toEqual([rotated.width, rotated.height]);
    });
  }

  it("builds the cache entry from the turned frame", () => {
    const j = job({ turn: 90, cacheEdge: 4 });
    const turned = rotateFloatRGBA(inlineFrame(j), j.width, j.height, 90);

    const out = built(j);

    expect(out.entry).toEqual(encodeCacheEntry(turned.data, turned.width, turned.height, 4));
  });

  it("builds no entry unless asked", () => {
    expect(built(job()).entry).toBeUndefined();
  });

  const brightImbalanced = (turn: number): FrameJob => {
    const width = 200;
    const height = 100;
    const pixels = new Uint16Array(width * height * 3);
    // Every second pixel is a blown, strongly red one; the rest are dark and grey.
    for (let p = 0; p < width * height; p++) {
      const o = p * 3;
      if (p % 2 === 0) {
        pixels[o] = 65535;
        pixels[o + 1] = 20000;
        pixels[o + 2] = 20000;
      } else {
        pixels.fill(1000, o, o + 3);
      }
    }
    return job({ pixels, width, height, turn, gain: 3 });
  };

  for (const turn of [0, 90, 180, 270]) {
    it(`rejects a blown, colour-imbalanced decode, judged before the ${turn} degree turn`, () => {
      const out = buildFrame(brightImbalanced(turn));

      expect(out).toEqual({ rejected: expect.stringMatching(/^rejected: blown\+imbalanced R=/) });
    });
  }

  it("lets a Foveon frame through the colour-balance check", () => {
    expect(buildFrame({ ...brightImbalanced(0), foveon: true })).toHaveProperty("data");
  });

  it("builds no entry for a rejected frame", () => {
    expect(buildFrame({ ...brightImbalanced(0), cacheEdge: 64 })).not.toHaveProperty("entry");
  });
});

describe("toSrgb8", () => {
  /** The 8-bit encode the import thumbnail ran inline. */
  function inlineSrgb(data: Float32Array): Uint8ClampedArray {
    const out = new Uint8ClampedArray(data.length);
    for (let o = 0; o < data.length; o += 4) {
      for (let c = 0; c < 3; c++) {
        let v = data[o + c];
        v = v <= 0 ? 0 : v >= 1 ? 1 : v;
        v = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
        out[o + c] = Math.round(v * 255);
      }
      out[o + 3] = 255;
    }
    return out;
  }

  it("encodes linear floats as the inline thumbnail encode does", () => {
    const data = Float32Array.from([
      -0.5, 0, 0.0031308, 1,
      0.0031309, 0.18, 0.5, 1,
      2, 1, 0.9999, 0.5,
    ]);

    expect(toSrgb8(data)).toEqual(inlineSrgb(data));
  });
});

describe("handleFrameRequest", () => {
  it("answers a build with the frame and moves its buffers", () => {
    const j = job({ cacheEdge: 4 });

    const { reply, transfer } = handleFrameRequest({ id: 7, op: "build", job: j });

    if (reply.op !== "build" || "rejected" in reply.result) throw new Error("no frame");
    expect(reply.id).toBe(7);
    expect(transfer).toContain(reply.result.data.buffer);
    expect(transfer).toContain(reply.result.entry?.preview.data.buffer);
    expect(transfer).toContain(reply.result.entry?.sample.data.buffer);
  });

  it("answers a failure with its message", () => {
    const { reply } = handleFrameRequest({ id: 3, op: "build", job: job({ pixels: null as never }) });

    expect(reply).toEqual({ id: 3, op: "error", message: expect.any(String) });
  });
});
