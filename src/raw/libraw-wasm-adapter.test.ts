// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { kelvinFromWhiteBalanceGains } from "@/rendering/blackbody";

const h = vi.hoisted(() => ({
  /** What the pooled libraw instance answers from metadata(). */
  metadata: {} as Record<string, unknown>,
  /** What imageData() hands back: libraw's processed 16-bit frame. */
  pixels: undefined as Uint16Array | undefined,
  /** Makes open() fail, the way an unsupported camera does. */
  openError: null as Error | null,
  /** Bytes handed to open(), in order. */
  opened: [] as Uint8Array[],
  acquired: 0,
  released: [] as unknown[],
}));

vi.mock("./decode-pool", () => {
  const instance = {
    async open(bytes: Uint8Array) {
      h.opened.push(bytes);
      if (h.openError) throw h.openError;
    },
    async metadata() {
      return h.metadata;
    },
    async imageData() {
      return h.pixels;
    },
  };
  return {
    acquireInstance: async () => {
      h.acquired++;
      return instance;
    },
    releaseInstance: (inst: unknown) => {
      h.released.push(inst);
    },
  };
});

import { decodeRawFloatViaLibRaw, extractRawMetadata } from "./libraw-wasm-adapter";

const MIB = 1024 * 1024;
const rawBytes = (size = 2 * MIB): ArrayBuffer => new ArrayBuffer(size);

/** The smallest frame the adapter accepts: 2×2 three-channel 16-bit, with the
 *  first pixel lit to `level` in every channel and the rest black. */
function litPixelFrame(level: number): Uint16Array {
  const px = new Uint16Array(2 * 2 * 3);
  px[0] = px[1] = px[2] = level;
  return px;
}

/** The 16-bit code libraw-wasm emits for a linear value: its output is Rec.709
 *  encoded (dcraw's default transfer, power 0.45 with a 4.5 toe) whatever
 *  gamma the settings ask for. */
function code(linear: number): number {
  const y = linear < 0.018 ? linear * 4.5 : 1.099 * Math.pow(linear, 0.45) - 0.099;
  return Math.min(65535, Math.round(y * 65536));
}

beforeEach(() => {
  h.metadata = {};
  h.pixels = undefined;
  h.openError = null;
  h.opened = [];
  h.acquired = 0;
  h.released = [];
  // libraw runs in a Worker on shared memory; Node has the latter, not the former.
  vi.stubGlobal("Worker", class {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("extractRawMetadata", () => {
  it("reports the frame libraw decodes and the as-shot white balance", async () => {
    h.metadata = {
      width: 6240,
      height: 4160,
      raw_width: 6384,
      raw_height: 4182,
      color_data: { cam_mul: [2.1, 1, 1.6, 1] },
    };

    await expect(extractRawMetadata(rawBytes())).resolves.toEqual({
      frame: { width: 6240, height: 4160 },
      colorTemperature: kelvinFromWhiteBalanceGains(2.1, 1, 1.6),
    });
  });

  it("takes the frame as libraw reports it — a portrait shot comes back already upright", async () => {
    h.metadata = { width: 4160, height: 6240 };

    expect((await extractRawMetadata(rawBytes()))?.frame).toEqual({ width: 4160, height: 6240 });
  });

  it("never sizes the frame from the raw sensor readout", async () => {
    // raw_width/raw_height include the masked borders — larger than any image.
    h.metadata = { width: 0, height: 0, raw_width: 6384, raw_height: 4182 };

    expect((await extractRawMetadata(rawBytes()))?.frame).toBeUndefined();
  });

  it("leaves the white balance unset when libraw exposes no camera multipliers", async () => {
    h.metadata = { width: 10, height: 10, color_data: {} };

    const meta = await extractRawMetadata(rawBytes());

    expect(meta?.frame).toEqual({ width: 10, height: 10 });
    expect(meta?.colorTemperature).toBeUndefined();
  });

  it("reports the exposure bias a Fujifilm DR mode left in the raw", async () => {
    h.metadata = { width: 1, height: 1, metadata_common: { ExposureCalibrationShift: -0.72 } };

    expect((await extractRawMetadata(rawBytes()))?.rawExposureBias).toBe(-0.72);
  });

  it("answers undefined for a file libraw can't open, and still frees its slot", async () => {
    h.openError = new Error("LibRaw: open_buffer() failed with code -2");

    await expect(extractRawMetadata(rawBytes())).resolves.toBeUndefined();
    expect(h.released).toHaveLength(1);
  });

  it("frees the pooled instance after a successful read", async () => {
    h.metadata = { width: 1, height: 1 };

    await extractRawMetadata(rawBytes());

    expect(h.acquired).toBe(1);
    expect(h.released).toHaveLength(1);
  });

  it("skips a file below the size floor without touching the pool", async () => {
    await expect(extractRawMetadata(rawBytes(512 * 1024))).resolves.toBeUndefined();
    expect(h.acquired).toBe(0);
  });

  it("hands libraw a copy so the caller's buffer survives the transfer", async () => {
    const buffer = rawBytes();
    h.metadata = { width: 1, height: 1 };

    await extractRawMetadata(buffer);

    expect(h.opened[0].buffer).not.toBe(buffer);
    expect(h.opened[0].byteLength).toBe(buffer.byteLength);
  });
});

describe("decodeRawFloatViaLibRaw", () => {
  // libraw-wasm ignores the gamma it is asked for and always hands back
  // Rec.709-encoded samples; the float image must be scene-linear.
  it("linearises the Rec.709 transfer libraw-wasm bakes into its samples", async () => {
    h.metadata = { width: 2, height: 2, color_data: { cam_mul: [1, 1, 1, 1] } };
    h.pixels = litPixelFrame(code(0.222));

    expect((await decodeRawFloatViaLibRaw(rawBytes()))?.data[1]).toBeCloseTo(0.222, 3);
  });

  it("linearises the toe of that transfer too", async () => {
    h.metadata = { width: 2, height: 2, color_data: { cam_mul: [1, 1, 1, 1] } };
    h.pixels = litPixelFrame(code(0.01));

    expect((await decodeRawFloatViaLibRaw(rawBytes()))?.data[1]).toBeCloseTo(0.01, 3);
  });

  // libraw's blend highlight mode normalises the WB multipliers to the largest
  // one so no channel can clip, which parks green sensor-white at 1 / 2.1
  // instead of 1.0. The float image has to put it back at 1.0.
  it("restores the white point libraw lowers to keep blended highlights unclipped", async () => {
    h.metadata = { width: 2, height: 2, color_data: { cam_mul: [2.1, 1, 1.6, 1] } };
    h.pixels = litPixelFrame(code(1 / 2.1));

    const image = await decodeRawFloatViaLibRaw(rawBytes());

    expect(image?.data[1]).toBeCloseTo(1, 2);
  });

  it("ignores the absent second green of a three-colour sensor", async () => {
    h.metadata = { width: 2, height: 2, color_data: { cam_mul: [579, 302, 485, 0] } };
    h.pixels = litPixelFrame(code(302 / 579));

    expect((await decodeRawFloatViaLibRaw(rawBytes()))?.data[1]).toBeCloseTo(1, 2);
  });

  it("falls back to the daylight multipliers when the camera set is unusable", async () => {
    h.metadata = {
      width: 2,
      height: 2,
      color_data: { cam_mul: [0, 0, 0, 0], pre_mul: [2.4, 1, 1.3, 1] },
    };
    h.pixels = litPixelFrame(code(1 / 2.4));

    expect((await decodeRawFloatViaLibRaw(rawBytes()))?.data[1]).toBeCloseTo(1, 2);
  });

  // Fujifilm's DR modes expose the sensor below the tagged ISO and let the
  // camera JPEG push it back; the RAF records by how much (RawExposureBias:
  // -0.72 EV at DR100, -1.72 at DR200, -2.72 at DR400). libraw reports the tag
  // but never applies it.
  it("pushes a Fujifilm raw back up by the exposure bias libraw reports", async () => {
    h.metadata = {
      width: 2,
      height: 2,
      color_data: { cam_mul: [1, 1, 1, 1] },
      metadata_common: { ExposureCalibrationShift: -2.72 },
    };
    h.pixels = litPixelFrame(code(1 / 2 ** 2.72));

    const image = await decodeRawFloatViaLibRaw(rawBytes());

    expect(image?.data[1]).toBeCloseTo(1, 2);
    expect(image?.rawExposureBias).toBe(-2.72);
  });

  it("derives the bias from the auto-selected DR mode on bodies that predate the tag", async () => {
    h.metadata = {
      width: 2,
      height: 2,
      color_data: { cam_mul: [1, 1, 1, 1] },
      metadata_common: { ExposureCalibrationShift: 0 },
      fuji: { DynamicRangeSetting: 0, AutoDynamicRange: 200 },
    };
    h.pixels = litPixelFrame(code(0.5));

    const image = await decodeRawFloatViaLibRaw(rawBytes());

    expect(image?.data[1]).toBeCloseTo(1, 2);
    expect(image?.rawExposureBias).toBe(-1);
  });

  it("ignores the 65535 sentinel libraw reports for an unset DR tag", async () => {
    h.metadata = {
      width: 2,
      height: 2,
      color_data: { cam_mul: [1, 1, 1, 1] },
      fuji: { DynamicRangeSetting: 0, DevelopmentDynamicRange: 65535, AutoDynamicRange: 100 },
    };
    h.pixels = litPixelFrame(code(1));

    const image = await decodeRawFloatViaLibRaw(rawBytes());

    expect(image?.data[1]).toBeCloseTo(1, 2);
    expect(image?.rawExposureBias).toBeUndefined();
  });

  it("derives the bias from a manually developed DR mode", async () => {
    h.metadata = {
      width: 2,
      height: 2,
      color_data: { cam_mul: [1, 1, 1, 1] },
      fuji: { DynamicRangeSetting: 1, DevelopmentDynamicRange: 400 },
    };
    h.pixels = litPixelFrame(code(0.25));

    const image = await decodeRawFloatViaLibRaw(rawBytes());

    expect(image?.data[1]).toBeCloseTo(1, 2);
    expect(image?.rawExposureBias).toBe(-2);
  });
});
