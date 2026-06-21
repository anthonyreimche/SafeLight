// Tests for the baseline TIFF writer. Round-trips through UTIF (the same
// decoder the app uses for reading TIFFs) to confirm the container is valid and
// the RGB samples survive at both bit depths. Run with `npm test`.

import { describe, it, expect } from "vitest";
import * as UTIF from "utif2";
import { encodeTiff } from "./tiff.ts";
import { buildIccProfile } from "@/rendering/color-space";

// A 2×2 RGBA image with distinct, asymmetric pixels so any row/column flip or
// channel swap shows up.
function sample8(): Uint8Array {
  return new Uint8Array([
    255, 0, 0, 255, /**/ 0, 255, 0, 255,
    0, 0, 255, 255, /**/ 255, 255, 0, 255,
  ]);
}

describe("encodeTiff", () => {
  it("writes a decodable 8-bit RGB TIFF with the right pixels", () => {
    const bytes = encodeTiff(sample8(), 2, 2, { bitDepth: 8 });
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

    const ifds = UTIF.decode(ab);
    expect(ifds.length).toBe(1);
    UTIF.decodeImage(ab, ifds[0]);
    expect(ifds[0].width).toBe(2);
    expect(ifds[0].height).toBe(2);

    const rgba = UTIF.toRGBA8(ifds[0]);
    // Top-left red, top-right green, bottom-left blue, bottom-right yellow.
    expect([rgba[0], rgba[1], rgba[2]]).toEqual([255, 0, 0]);
    expect([rgba[4], rgba[5], rgba[6]]).toEqual([0, 255, 0]);
    expect([rgba[8], rgba[9], rgba[10]]).toEqual([0, 0, 255]);
    expect([rgba[12], rgba[13], rgba[14]]).toEqual([255, 255, 0]);
  });

  it("writes a 16-bit TIFF preserving full-range samples", () => {
    const px = new Uint16Array([
      65535, 0, 0, 65535, /**/ 0, 32768, 0, 65535,
      0, 0, 65535, 65535, /**/ 12345, 54321, 600, 65535,
    ]);
    const bytes = encodeTiff(px, 2, 2, { bitDepth: 16 });
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

    const ifds = UTIF.decode(ab);
    UTIF.decodeImage(ab, ifds[0]);
    expect(Number((ifds[0]["t258"] as number[])[0])).toBe(16); // BitsPerSample

    // UTIF exposes the raw 16-bit samples on the decoded IFD data as a typed view.
    const raw = new Uint16Array(
      (ifds[0].data as Uint8Array).buffer,
      (ifds[0].data as Uint8Array).byteOffset,
      (ifds[0].data as Uint8Array).byteLength / 2,
    );
    // First pixel RGB = (65535, 0, 0); last pixel RGB = (12345, 54321, 600).
    expect([raw[0], raw[1], raw[2]]).toEqual([65535, 0, 0]);
    const lastBase = (2 * 2 - 1) * 3;
    expect([raw[lastBase], raw[lastBase + 1], raw[lastBase + 2]]).toEqual([12345, 54321, 600]);
  });

  it("embeds an ICC profile when provided", () => {
    const icc = buildIccProfile("adobe-rgb");
    const bytes = encodeTiff(sample8(), 2, 2, { bitDepth: 8, icc });
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const ifds = UTIF.decode(ab);
    const tag = ifds[0]["t34675"] as unknown;
    expect(tag).toBeDefined();
    expect((tag as { length: number }).length).toBe(icc.length);
  });
});
