// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeLinearDng, float24, linearDngKind, type LinearDngResult } from "./linear-dng";
import { COMPRESSION, PHOTOMETRIC_CFA, PHOTOMETRIC_LINEAR_RAW, TIFF_TAG } from "./tiff";
import { TYPE, buildTiffWithTrailer, field, type Field } from "./tiff.test-support";

// The fixtures were written by tifffile + imagecodecs (an encoder independent of
// this decoder) with this pattern in every channel, exact in float16.
const W = 20;
const H = 12;
const pattern = (x: number, y: number, c: number): number => ((3 * x + 5 * y + 7 * c) % 16) / 16 + 1 / 64;

function fixture(name: string): ArrayBuffer {
  const bytes = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "linear-dng", `${name}.dng`));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

type Frame = Exclude<LinearDngResult, { rejected: string }>;

async function decode(
  buffer: ArrayBuffer,
  job: { turn?: number; targetEdge?: number; cacheEdge?: number; memoryBudget?: number } = {},
): Promise<Frame> {
  const result = await decodeLinearDng({ buffer, turn: job.turn ?? 0, ...job });
  if ("rejected" in result) throw new Error(result.rejected);
  return result;
}

function pixel(frame: Frame, x: number, y: number): number[] {
  const o = (y * frame.width + x) * 4;
  return Array.from(frame.data.subarray(o, o + 4));
}

// The fixtures' colour matrix makes the camera linear sRGB (to the precision
// of its published constants), so each decoded channel is the stored value.
function expectPattern(frame: Frame, at: (x: number, y: number, c: number) => number): void {
  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) {
      const [r, g, b, a] = pixel(frame, x, y);
      expect([r, g, b].map((v, c) => Math.abs(v - at(x, y, c))).every((d) => d < 2e-3)).toBe(true);
      expect(a).toBe(1);
    }
  }
}

describe("linearDngKind", () => {
  it("knows the floating-point LinearRaw DNGs it leads for", () => {
    expect(linearDngKind(fixture("f16-tiled-deflate"))).toBe("float");
    expect(linearDngKind(fixture("f32-strips-deflate-be"))).toBe("float");
    expect(linearDngKind(fixture("f32-uncompressed-crop"))).toBe("float");
  });

  it("knows the integer LinearRaw DNGs it can stand in for", () => {
    expect(linearDngKind(fixture("u16-strips-deflate-pred2"))).toBe("integer");
  });

  it("leaves mosaic DNGs, other files and LinearRaw layouts it can't read to libraw", () => {
    expect(linearDngKind(built({ photometric: PHOTOMETRIC_CFA }).buffer)).toBeNull();
    expect(linearDngKind(built({ compression: 7 }).buffer)).toBeNull();
    expect(linearDngKind(new TextEncoder().encode("not a tiff at all").buffer)).toBeNull();
  });
});

describe("decodeLinearDng", () => {
  it("reads float16 Deflate tiles with the floating-point predictor from a SubIFD", async () => {
    const frame = await decode(fixture("f16-tiled-deflate"));
    expect([frame.width, frame.height]).toEqual([W, H]);
    expectPattern(frame, pattern);
  });

  it("reads big-endian float32 Deflate strips, the last one short", async () => {
    const frame = await decode(fixture("f32-strips-deflate-be"));
    expect([frame.width, frame.height]).toEqual([W, H]);
    expectPattern(frame, pattern);
  });

  it("reads 16-bit integer strips with the horizontal predictor, scaled between BlackLevel and WhiteLevel", async () => {
    const frame = await decode(fixture("u16-strips-deflate-pred2"));
    expectPattern(frame, pattern);
  });

  // Safelight's libraw decode of a DNG leaves BaselineExposure out of the
  // pixels too; the renderer's camera exposure stands in for it.
  it("crops to DefaultCrop and turns by Orientation, leaving BaselineExposure out", async () => {
    // A 16×10 crop at (2, 1), Orientation 6 (a quarter turn clockwise), +1 EV.
    const frame = await decode(fixture("f32-uncompressed-crop"));
    expect([frame.width, frame.height]).toEqual([10, 16]);
    expectPattern(frame, (x, y, c) => pattern(2 + y, 1 + (9 - x), c));
  });

  it("turns by the request's turn on top of the file's orientation", async () => {
    const frame = await decode(fixture("f16-tiled-deflate"), { turn: 180 });
    expectPattern(frame, (x, y, c) => pattern(W - 1 - x, H - 1 - y, c));
  });

  it("decodes at half size when half the frame still reaches the target edge", async () => {
    const frame = await decode(fixture("f16-tiled-deflate"), { targetEdge: 10 });
    expect([frame.width, frame.height]).toEqual([10, 6]);
    expect([frame.sourceWidth, frame.sourceHeight]).toEqual([W, H]);
    const mean = (x: number, y: number, c: number) =>
      (pattern(2 * x, 2 * y, c) + pattern(2 * x + 1, 2 * y, c) + pattern(2 * x, 2 * y + 1, c) + pattern(2 * x + 1, 2 * y + 1, c)) / 4;
    expectPattern(frame, mean);
  });

  it("decodes at full size when half would fall short of the target edge", async () => {
    const frame = await decode(fixture("f16-tiled-deflate"), { targetEdge: 11 });
    expect([frame.width, frame.height]).toEqual([W, H]);
    expect(frame.sourceWidth).toBeUndefined();
  });

  it("builds the develop-preview cache entry when asked", async () => {
    const frame = await decode(fixture("f16-tiled-deflate"), { cacheEdge: 8 });
    expect(frame.entry).toBeDefined();
  });

  it("reads float24 samples behind the floating-point X2 predictor", async () => {
    const values = [1, -1.5, 0.25, 0.75, 0.5, 2, 0.125, 1.5, 0.0625, 3, 0.375, 0.875];
    const frame = await decode(float24File(values).buffer);
    expect([frame.width, frame.height]).toEqual([4, 1]);
    for (let x = 0; x < 4; x++) {
      pixel(frame, x, 0).slice(0, 3).forEach((v, c) => expect(Math.abs(v - values[3 * x + c])).toBeLessThan(2e-3));
    }
  });

  it("balances the frame by AsShotNeutral and reports the as-shot white", async () => {
    const frame = await decode(
      built({ extra: [field(TIFF_TAG.AsShotNeutral, TYPE.RATIONAL, 1, 2, 1, 1, 4, 5)], fill: [0.5, 1, 0.8] }).buffer,
    );
    expect(pixel(frame, 0, 0).slice(0, 3).every((v) => Math.abs(v - 1) < 2e-3)).toBe(true);
    expect(frame.asShotMultipliers?.map((v) => +v.toFixed(4))).toEqual([2, 1, 1.25]);
    expect(frame.colorTemperature).toBeGreaterThan(0);
  });

  it("zeroes channels that aren't numbers", async () => {
    const frame = await decode(built({ fill: [NaN, Infinity, 0.5] }).buffer);
    const [r, g, b] = pixel(frame, 0, 0);
    expect([r, g, b].map((v) => Math.abs(v - 0) < 1e-3)).toEqual([true, true, false]);
    expect(b).toBeCloseTo(0.5, 3);
  });

  it("rejects a Deflate stream that won't inflate", async () => {
    const file = built({ compression: COMPRESSION.Deflate, raw: new Uint8Array(48).fill(7) });
    expect(await decodeLinearDng({ buffer: file.buffer, turn: 0 })).toMatchObject({ rejected: expect.any(String) });
  });

  it("rejects strips that run past the end of the file", async () => {
    const file = built({ stripByteCount: 1 << 30 });
    expect(await decodeLinearDng({ buffer: file.buffer, turn: 0 })).toMatchObject({ rejected: expect.any(String) });
  });
});

describe("decodeLinearDng within its memory budget", () => {
  // The f16 fixture is 20×12 and 1,387 bytes: 5,227 bytes at full size, 2,347 at half.
  it("decodes at half size when the full frame would pass the budget", async () => {
    const frame = await decode(fixture("f16-tiled-deflate"), { memoryBudget: 4_000 });
    expect([frame.width, frame.height, frame.sourceWidth, frame.sourceHeight]).toEqual([10, 6, W, H]);
  });

  it("calls a file too large that passes the budget even at half size", async () => {
    const result = await decodeLinearDng({ buffer: fixture("f16-tiled-deflate"), turn: 0, memoryBudget: 2_000 });
    expect(result).toMatchObject({ rejected: expect.any(String), tooLarge: true });
  });

  it("calls a header claiming more pixels than any photo too large, before allocating", async () => {
    const huge = built({ extra: [field(TIFF_TAG.ImageWidth, TYPE.LONG, 60_000), field(TIFF_TAG.ImageLength, TYPE.LONG, 60_000), field(TIFF_TAG.RowsPerStrip, TYPE.LONG, 60_000)] });
    expect(await decodeLinearDng({ buffer: huge.buffer, turn: 0 })).toMatchObject({ tooLarge: true });
  });
});

describe("decodeLinearDng on odd files", () => {
  it("inflates only what the strip needs, past trailing padding", async () => {
    const samples = new Uint8Array(new Float32Array([0.25, 0.5, 0.75]).buffer);
    const padded = new Uint8Array([...deflateSync(samples), 0, 0, 0, 0]);
    const frame = await decode(built({ compression: COMPRESSION.Deflate, raw: padded }).buffer);
    expect(pixel(frame, 0, 0).slice(0, 3).map((v) => +v.toFixed(3))).toEqual([0.25, 0.5, 0.75]);
  });

  it("stops inflating a stream that runs on past the frame", async () => {
    const runsOn = new Uint8Array(deflateSync(new Uint8Array(64 * 2 ** 20)));
    const frame = await decode(built({ compression: COMPRESSION.Deflate, raw: runsOn }).buffer);
    expect(pixel(frame, 0, 0).slice(0, 3)).toEqual([0, 0, 0]);
  });

  it("finds no image in a file whose size isn't a number", () => {
    const file = built({ extra: [field(TIFF_TAG.ImageWidth, TYPE.FLOAT, NaN)] });
    expect(linearDngKind(file.buffer)).toBeNull();
  });

  it("keeps the whole frame when the crop isn't a number", async () => {
    const frame = await decode(built({ extra: [field(TIFF_TAG.DefaultCropSize, TYPE.DOUBLE, NaN, NaN)] }).buffer);
    expect([frame.width, frame.height]).toEqual([1, 1]);
  });

  const COLOURED = [0.8, 0.3, 0.2] as const;
  const MIXING = field(TIFF_TAG.CameraCalibration1, TYPE.SRATIONAL, 1, 1, 1, 5, 0, 1, 0, 1, 1, 1, 0, 1, 0, 1, 0, 1, 1, 1);
  const signature = (tag: number, text: string) => field(tag, TYPE.ASCII, ...[...text].map((c) => c.charCodeAt(0)), 0);
  const red = async (extra: Field[]) => pixel(await decode(built({ fill: COLOURED, extra }).buffer), 0, 0)[0];

  it("applies CameraCalibration when the file names no calibration signature", async () => {
    expect(await red([MIXING, signature(TIFF_TAG.ProfileCalibrationSignature, "profile")])).not.toBeCloseTo(await red([]), 3);
  });

  it("ignores CameraCalibration measured for another profile", async () => {
    const other = [MIXING, signature(TIFF_TAG.CameraCalibrationSignature, "a"), signature(TIFF_TAG.ProfileCalibrationSignature, "b")];
    expect(await red(other)).toBeCloseTo(await red([]), 6);
  });
});

describe("float24", () => {
  it("reads DNG's 24-bit float: a sign, a 7-bit exponent biased by 63 and 16 mantissa bits", () => {
    expect(float24(0x3f, 0x00, 0x00)).toBe(1);
    expect(float24(0xbf, 0x80, 0x00)).toBe(-1.5);
    expect(float24(0x40, 0x40, 0x00)).toBe(2.5);
    expect(float24(0x00, 0x00, 0x01)).toBe(2 ** -78);
    expect(float24(0x7f, 0x00, 0x00)).toBe(Infinity);
    expect(float24(0x7f, 0x00, 0x01)).toBeNaN();
  });
});

// ─── Files laid out here ──────────────────────────────────────────────────────

// XYZ (D65) -> linear sRGB, as SRATIONALs over 10^7.
const SRGB_CM = [
  3.2404542, -1.5371385, -0.4985314, -0.969266, 1.8760108, 0.041556, 0.0556434, -0.2040259, 1.0572252,
].flatMap((v) => [Math.round(v * 1e7), 1e7]);

interface Layout {
  photometric?: number;
  compression?: number;
  extra?: Field[];
  /** One RGB float32 pixel, little-endian, uncompressed. */
  fill?: readonly [number, number, number];
  /** The strip's bytes as stored, instead of `fill`. */
  raw?: Uint8Array;
  stripByteCount?: number;
  predictor?: number;
  bits?: number;
  width?: number;
}

function built(layout: Layout = {}): { buffer: ArrayBuffer } {
  const { fill = [0.5, 0.5, 0.5], width = 1 } = layout;
  const pixel = new Uint8Array(new Float32Array(fill).buffer);
  const strip = layout.raw ?? pixel;
  const fields = (offset: number): Field[] => [
    field(TIFF_TAG.NewSubFileType, TYPE.LONG, 0),
    field(TIFF_TAG.ImageWidth, TYPE.LONG, width),
    field(TIFF_TAG.ImageLength, TYPE.LONG, 1),
    field(TIFF_TAG.BitsPerSample, TYPE.SHORT, ...[1, 2, 3].map(() => layout.bits ?? 32)),
    field(TIFF_TAG.Compression, TYPE.SHORT, layout.compression ?? COMPRESSION.None),
    field(TIFF_TAG.PhotometricInterpretation, TYPE.SHORT, layout.photometric ?? PHOTOMETRIC_LINEAR_RAW),
    field(TIFF_TAG.StripOffsets, TYPE.LONG, offset),
    field(TIFF_TAG.SamplesPerPixel, TYPE.SHORT, 3),
    field(TIFF_TAG.RowsPerStrip, TYPE.LONG, 1),
    field(TIFF_TAG.StripByteCounts, TYPE.LONG, layout.stripByteCount ?? strip.length),
    ...(layout.predictor ? [field(TIFF_TAG.Predictor, TYPE.SHORT, layout.predictor)] : []),
    field(TIFF_TAG.SampleFormat, TYPE.SHORT, 3, 3, 3),
    field(TIFF_TAG.ColorMatrix1, TYPE.SRATIONAL, ...SRGB_CM),
    field(TIFF_TAG.CalibrationIlluminant1, TYPE.SHORT, 21),
    ...(layout.extra ?? []),
  ];
  const { trailerOffset } = buildTiffWithTrailer([{ fields: fields(0) }], { trailer: strip });
  return buildTiffWithTrailer([{ fields: fields(trailerOffset) }], { trailer: strip });
}

// 4×1 RGB float24, Deflate, predictor 34894 (floating point, X2): its byte
// planes (most significant first) differenced two pixels apart.
function float24File(values: readonly number[]): { buffer: ArrayBuffer } {
  const encode = (v: number): number[] => {
    const sign = v < 0 ? 0x80 : 0;
    const a = Math.abs(v);
    const exponent = Math.floor(Math.log2(a));
    const mantissa = Math.round((a / 2 ** exponent - 1) * 65536);
    return [sign | (exponent + 63), mantissa >> 8, mantissa & 0xff];
  };
  const samples = values.map(encode);
  const n = samples.length;
  const planes = new Uint8Array(3 * n);
  samples.forEach((bytes, s) => bytes.forEach((b, k) => (planes[k * n + s] = b)));
  const stride = 3 * 2;
  for (let i = planes.length - 1; i >= stride; i--) planes[i] = (planes[i] - planes[i - stride]) & 0xff;
  return built({
    width: 4,
    bits: 24,
    compression: COMPRESSION.Deflate,
    predictor: 34894,
    raw: new Uint8Array(deflateSync(planes)),
  });
}

// Running out of memory under a budget the frame fits is the machine's state,
// not the file's: only a frame past the budget is called too large for good.
describe("decodeLinearDng short of memory", () => {
  const failing = (lengths: number[]) => {
    const short = new Proxy(Float32Array, {
      construct(target, args, newTarget) {
        const [length] = args;
        if (typeof length === "number" && lengths.includes(length)) throw new RangeError("Array buffer allocation failed");
        return Reflect.construct(target, args, newTarget);
      },
    });
    vi.stubGlobal("Float32Array", short);
  };
  afterEach(() => vi.unstubAllGlobals());

  it("decodes at half size when the full frame can't be had", async () => {
    failing([W * H * 4]);
    const frame = await decode(fixture("f16-tiled-deflate"));
    expect([frame.width, frame.height]).toEqual([W / 2, H / 2]);
  });

  it("answers a failure that may pass when even half size can't be had", async () => {
    failing([W * H * 4, (W / 2) * (H / 2) * 4]);
    const result = await decodeLinearDng({ buffer: fixture("f16-tiled-deflate"), turn: 0 });
    expect(result).toMatchObject({ rejected: expect.any(String), transient: true });
    expect(result).not.toHaveProperty("tooLarge");
  });
});
