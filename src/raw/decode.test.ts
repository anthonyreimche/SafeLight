// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, it, expect, vi } from "vitest";
import { decodeRawToFloat } from "./decode";
import { COMPRESSION, PHOTOMETRIC_CFA, TIFF_TAG } from "./tiff";
import { TYPE, buildTiffWithTrailer, field, type Field, type IfdSpec } from "./tiff.test-support";

// The in-house path is what these tests exercise; libraw is a Worker-only
// decoder and answers null here as it does anywhere without one.
vi.mock("./libraw-wasm-adapter", () => ({
  decodeRawFloatViaLibRaw: async () => null,
}));

const SIDE = 4;

/** An uncompressed 8-bit RGGB DNG whose single strip holds `pixels`. */
function dng(extra: Field[], pixels: Uint8Array): Blob {
  const spec = (stripOffset: number): IfdSpec => ({
    fields: [
      field(TIFF_TAG.PhotometricInterpretation, TYPE.SHORT, PHOTOMETRIC_CFA),
      field(TIFF_TAG.ImageWidth, TYPE.LONG, SIDE),
      field(TIFF_TAG.ImageLength, TYPE.LONG, SIDE),
      field(TIFF_TAG.BitsPerSample, TYPE.SHORT, 8),
      field(TIFF_TAG.Compression, TYPE.SHORT, COMPRESSION.None),
      field(TIFF_TAG.SamplesPerPixel, TYPE.SHORT, 1),
      field(TIFF_TAG.RowsPerStrip, TYPE.LONG, SIDE),
      field(TIFF_TAG.StripOffsets, TYPE.LONG, stripOffset),
      field(TIFF_TAG.StripByteCounts, TYPE.LONG, pixels.length),
      field(TIFF_TAG.CFAPattern, TYPE.BYTE, 0, 1, 1, 2),
      ...extra,
    ],
  });
  // The strip's offset is a field value, so lay the file out once to learn
  // where the trailer lands, then once more pointing at it.
  const { trailerOffset } = buildTiffWithTrailer([spec(0)], { trailer: pixels });
  const { buffer } = buildTiffWithTrailer([spec(trailerOffset)], { trailer: pixels });
  return new Blob([buffer]);
}

const plane = (code: number): Uint8Array => new Uint8Array(SIDE * SIDE).fill(code);

// A flat plane demosaics to itself, so every channel of every pixel carries
// the one normalised value.
async function flatValue(file: Blob): Promise<number> {
  const image = await decodeRawToFloat(file);
  expect(image).not.toBeNull();
  expect([image!.width, image!.height]).toEqual([SIDE, SIDE]);
  const rgb = Array.from(image!.data).filter((_, i) => i % 4 !== 3);
  const [first] = rgb;
  for (const v of rgb) expect(v).toBeCloseTo(first, 5);
  return first;
}

// Leica M8 style: 8-bit stored codes, a table that expands them to 14-bit
// linear values, and a WhiteLevel in that linear space.
const TABLE = field(TIFF_TAG.LinearizationTable, TYPE.SHORT, 0, 1000, 4000, 8000);

describe("decodeRawToFloat in-house path", () => {
  it("scales stored codes against the white level when there is no table", async () => {
    const file = dng([field(TIFF_TAG.WhiteLevel, TYPE.LONG, 255)], plane(51));
    expect(await flatValue(file)).toBeCloseTo(51 / 255, 5);
  });

  it("maps stored codes through the LinearizationTable before scaling", async () => {
    const file = dng([TABLE, field(TIFF_TAG.WhiteLevel, TYPE.LONG, 16000)], plane(2));
    expect(await flatValue(file)).toBeCloseTo(4000 / 16000, 5);
  });

  it("clamps stored codes past the table's end to its last entry", async () => {
    const file = dng([TABLE, field(TIFF_TAG.WhiteLevel, TYPE.LONG, 16000)], plane(200));
    expect(await flatValue(file)).toBeCloseTo(8000 / 16000, 5);
  });

  it("takes the table's top entry as the white level when WhiteLevel is absent", async () => {
    const file = dng([TABLE], plane(2));
    expect(await flatValue(file)).toBeCloseTo(4000 / 8000, 5);
  });
});
