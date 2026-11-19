// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The decode core against the real libheif wasm, one module for every test.

import { describe, expect, it } from "vitest";
import { readHeifContainer, type HeifContainer } from "./heif-container";
import {
  answerHeifRequest,
  decodeHeifFrameBytes,
  decodeHeifThumbBytes,
  linearToHalfFrame,
  pixelsToThumb,
} from "./heif-decode";
import { HEIF_P3_10, HEIF_SRGB8, heifBlob, heifBytes } from "./heif-fixtures.test-support";
import { heifLib } from "./heif-lib";
import { halfToFloat32 } from "./half-float";
import type { HalfFrame } from "./profile-frame";

const lib = heifLib();
const loadLib = () => Promise.resolve(lib);

async function fixture(base64: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; container: HeifContainer | null }> {
  return { bytes: heifBytes(base64), container: await readHeifContainer(heifBlob(base64)) };
}

function pixel(frame: HalfFrame, x: number, y: number): number[] {
  const floats = halfToFloat32(frame.data);
  const o = (y * frame.width + x) * 4;
  return Array.from(floats.subarray(o, o + 4));
}

function expectNear(actual: number[], expected: number[], tolerance: number): void {
  expected.forEach((v, i) => expect(Math.abs(actual[i] - v), `channel ${i}: ${actual[i]} vs ${v}`).toBeLessThan(tolerance));
}

const srgbLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));

describe("decodeHeifFrameBytes", () => {
  it("decodes srgb8 upright, as libheif applies its irot", async () => {
    const { bytes, container } = await fixture(HEIF_SRGB8);
    const result = decodeHeifFrameBytes(lib, bytes, container, {});
    if (!result.ok) throw new Error(result.reason);
    expect(result).toMatchObject({ sourceWidth: 48, sourceHeight: 64, hdr: false });
    const { frame } = result;
    expect([frame.width, frame.height, frame.fullWidth, frame.fullHeight]).toEqual([48, 64, 48, 64]);
    const full = srgbLinear(1019 / 1023);
    expectNear(pixel(frame, 2, 2), [0, 0, full, 1], 0.01);
    expectNear(pixel(frame, 45, 2), [full, 0, 0, 1], 0.01);
    expectNear(pixel(frame, 2, 61), [srgbLinear(509 / 1023), srgbLinear(509 / 1023), srgbLinear(509 / 1023), 1], 0.01);
    expectNear(pixel(frame, 45, 61), [0, 1, 0, 1], 0.01);
  });

  it("keeps Display P3 red as negative green and blue", async () => {
    const { bytes, container } = await fixture(HEIF_P3_10);
    const result = decodeHeifFrameBytes(lib, bytes, container, {});
    if (!result.ok) throw new Error(result.reason);
    expect(result.frame.width).toBe(64);
    expectNear(pixel(result.frame, 2, 2), [1.2249, -0.0421, -0.0196, 1], 3e-3);
  });

  it("averages down to the target edge and bakes the turn", async () => {
    const { bytes, container } = await fixture(HEIF_P3_10);
    const result = decodeHeifFrameBytes(lib, bytes, container, { targetEdge: 16, turn: 90 });
    if (!result.ok) throw new Error(result.reason);
    const { frame } = result;
    expect([frame.width, frame.height, frame.fullWidth, frame.fullHeight]).toEqual([12, 16, 48, 64]);
    expect([result.sourceWidth, result.sourceHeight]).toEqual([64, 48]);
    // A clockwise turn brings the bottom-left (blue) quadrant to the top left.
    const blue = pixel(frame, 1, 1);
    expect(blue[2]).toBeGreaterThan(1);
    expect(blue[0]).toBeLessThan(0.01);
    expect(halfToFloat32(frame.data).every(Number.isFinite)).toBe(true);
  });

  it("refuses an image past the pixel cap before decoding it", async () => {
    const { bytes, container } = await fixture(HEIF_P3_10);
    const huge = { ...container!, width: 20_000, height: 6_000 };
    const result = decodeHeifFrameBytes(lib, bytes, huge, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/too large/);
  });

  it("answers a failure for bytes libheif can't read", () => {
    const result = decodeHeifFrameBytes(lib, new Uint8Array(100), null, {});
    expect(result.ok).toBe(false);
  });
});

describe("decodeHeifThumbBytes", () => {
  it("encodes a clipped sRGB thumbnail at the long edge asked for", async () => {
    const { bytes, container } = await fixture(HEIF_P3_10);
    const result = decodeHeifThumbBytes(lib, bytes, container, 32);
    if (!result.ok) throw new Error(result.reason);
    expect([result.width, result.height, result.sourceWidth, result.sourceHeight]).toEqual([32, 24, 64, 48]);
    const at = (x: number, y: number) => Array.from(result.data.subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 4));
    expect(at(1, 1)).toEqual([255, 0, 0, 255]);
    expect(at(30, 1)).toEqual([0, 255, 0, 255]);
    for (const v of at(30, 22).slice(0, 3)) expect(Math.abs(v - 127)).toBeLessThanOrEqual(1);
  });

  it("keeps srgb8 upright and full size when smaller than the edge", async () => {
    const { bytes, container } = await fixture(HEIF_SRGB8);
    const result = decodeHeifThumbBytes(lib, bytes, container, 256);
    if (!result.ok) throw new Error(result.reason);
    expect([result.width, result.height, result.sourceWidth, result.sourceHeight]).toEqual([48, 64, 48, 64]);
    expect(Array.from(result.data.subarray(0, 4))).toEqual([0, 0, 254, 255]);
  });
});

describe("linearToHalfFrame", () => {
  it("averages, turns and cleans an extension's linear frame", () => {
    const data = new Float32Array([
      1, 2, 3, 1, 3, 4, 5, 1, -1, 0.5, Number.NaN, 0.2, 0, 0, Number.POSITIVE_INFINITY, 1,
      1, 2, 3, 1, 3, 4, 5, 1, -1, 0.5, 0, 1, 0, 0, 0, 1,
    ]);
    const frame = linearToHalfFrame(data, 4, 2, { targetEdge: 2 });
    expect([frame.width, frame.height, frame.fullWidth, frame.fullHeight]).toEqual([2, 1, 4, 2]);
    expect(pixel(frame, 0, 0)).toEqual([2, 3, 4, 1]);
    expect(pixel(frame, 1, 0)).toEqual([-0.5, 0.25, 0, 1]);

    const turned = linearToHalfFrame(data, 4, 2, { turn: 90 });
    expect([turned.width, turned.height]).toEqual([2, 4]);
    expect(pixel(turned, 1, 0)).toEqual([1, 2, 3, 1]);
  });
});

describe("pixelsToThumb", () => {
  it("sRGB-encodes a linear image and box-averages an 8-bit one in linear light", () => {
    const linear = pixelsToThumb({ kind: "linear", data: new Float32Array([0.5, 2, -1, 1]), width: 1, height: 1 }, 8);
    expect(Array.from(linear.data)).toEqual([188, 255, 0, 255]);
    const rgba8 = pixelsToThumb(
      { kind: "rgba8", data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 255]), width: 2, height: 1 },
      1,
    );
    expect([rgba8.width, rgba8.height]).toEqual([1, 1]);
    expect(Array.from(rgba8.data)).toEqual([188, 0, 0, 255]);
  });
});

describe("answerHeifRequest", () => {
  it("answers a frame request with its buffer to transfer", async () => {
    const { reply, transfer } = await answerHeifRequest(loadLib, {
      id: 7,
      op: "frame",
      file: heifBlob(HEIF_P3_10),
      targetEdge: 32,
      turn: 0,
    });
    if (reply.op !== "frame") throw new Error(`answered ${reply.op}`);
    expect(reply.id).toBe(7);
    expect(reply.frame.width).toBe(32);
    expect(transfer).toEqual([reply.frame.data.buffer]);
  });

  it("answers an error for a file that isn't a HEIF", async () => {
    const { reply } = await answerHeifRequest(loadLib, { id: 8, op: "thumb", file: new Blob([new Uint8Array(64)]), maxEdge: 32 });
    expect(reply.op).toBe("error");
  });
});
