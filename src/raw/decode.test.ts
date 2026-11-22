// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { decodeRawToBitmap, decodeRawToFloat } from "./decode";
import { COMPRESSION, PHOTOMETRIC_CFA, PHOTOMETRIC_LINEAR_RAW, TIFF_TAG } from "./tiff";
import { TYPE, buildTiffWithTrailer, field, type Field, type IfdSpec } from "./tiff.test-support";

const libraw = vi.hoisted(() => ({
  /** Whether each libraw decode was asked for as background work. */
  background: [] as (boolean | undefined)[],
  /** Whether each libraw decode was handed its buffer to keep. */
  transfers: [] as (boolean | undefined)[],
  /** Holds each libraw decode until it settles. */
  gate: Promise.resolve(),
}));

// The in-house path is what these tests exercise; libraw is a Worker-only
// decoder and can't run here, as anywhere without one.
vi.mock("./libraw-wasm-adapter", () => ({
  decodeRawFloatViaLibRaw: async (
    _buffer: ArrayBuffer,
    priority?: { background?: boolean },
    transfer?: boolean,
  ) => {
    libraw.background.push(priority?.background);
    libraw.transfers.push(transfer);
    await libraw.gate;
    return { failure: "transient" as const };
  },
}));

const SIDE = 4;

interface Layout {
  width?: number;
  height?: number;
  /** One StripByteCounts value per strip; every strip starts at the pixels. */
  stripByteCounts?: number[];
}

/** An uncompressed 8-bit RGGB DNG whose strip holds `pixels`. */
function dng(extra: Field[], pixels: Uint8Array, layout: Layout = {}): Blob {
  const { width = SIDE, height = SIDE, stripByteCounts = [pixels.length] } = layout;
  const spec = (stripOffset: number): IfdSpec => ({
    fields: [
      field(TIFF_TAG.PhotometricInterpretation, TYPE.SHORT, PHOTOMETRIC_CFA),
      field(TIFF_TAG.ImageWidth, TYPE.LONG, width),
      field(TIFF_TAG.ImageLength, TYPE.LONG, height),
      field(TIFF_TAG.BitsPerSample, TYPE.SHORT, 8),
      field(TIFF_TAG.Compression, TYPE.SHORT, COMPRESSION.None),
      field(TIFF_TAG.SamplesPerPixel, TYPE.SHORT, 1),
      field(TIFF_TAG.RowsPerStrip, TYPE.LONG, height),
      field(TIFF_TAG.StripOffsets, TYPE.LONG, ...stripByteCounts.map(() => stripOffset)),
      field(TIFF_TAG.StripByteCounts, TYPE.LONG, ...stripByteCounts),
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
// the one normalized value.
async function flatValue(file: Blob): Promise<number> {
  const image = await decodeRawToFloat(file);
  if ("failure" in image) throw new Error(`no image: ${image.failure}`);
  expect([image.width, image.height]).toEqual([SIDE, SIDE]);
  const rgb = Array.from(image.data).filter((_, i) => i % 4 !== 3);
  const [first] = rgb;
  for (const v of rgb) expect(v).toBeCloseTo(first, 5);
  return first;
}

// Leica M8 style: 8-bit stored codes, a table that expands them to 14-bit
// linear values, and a WhiteLevel in that linear space.
const TABLE = field(TIFF_TAG.LinearizationTable, TYPE.SHORT, 0, 1000, 4000, 8000);

describe("decodeRawToFloat priority", () => {
  beforeEach(() => {
    libraw.background = [];
  });

  it("hands a background decode's priority on to libraw", async () => {
    await decodeRawToFloat(new Blob(["raw"]), { background: true });
    await decodeRawToFloat(new Blob(["raw"]));
    expect(libraw.background).toEqual([true, undefined]);
  });
});

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

// The in-house path declining leaves libraw's verdict as the answer, so the
// caller shows the embedded preview; an in-house throw would add its reason.
describe("decodeRawToFloat in-house path on a damaged header", () => {
  it("declines a header claiming 30000x30000 over a 1 KB strip", async () => {
    const file = dng([], new Uint8Array(1024).fill(51), { width: 30_000, height: 30_000 });

    expect(await decodeRawToFloat(file)).toEqual({ failure: "transient" });
    expect(await decodeRawToBitmap(file)).toBeNull();
  });

  it("declines strips that hold fewer bytes than the frame needs", async () => {
    const file = dng([], new Uint8Array(1024).fill(51), { width: 64, height: 64 });

    expect(await decodeRawToFloat(file)).toEqual({ failure: "transient" });
    expect(await decodeRawToBitmap(file)).toBeNull();
  });

  it("declines strip byte counts that add up past the file without allocating them", async () => {
    const file = dng([], plane(51), { stripByteCounts: Array.from({ length: 1024 }, () => 0xffffffff) });

    const started = performance.now();
    expect(await decodeRawToFloat(file)).toEqual({ failure: "transient" });
    expect(await decodeRawToBitmap(file)).toBeNull();
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("declines a strip that runs past the end of the file", async () => {
    const file = dng([], plane(51), { stripByteCounts: [0xffffffff] });

    expect(await decodeRawToFloat(file)).toEqual({ failure: "transient" });
  });
});

// In Electron each arrayBuffer() copies the whole file, in the browser it
// reads it off the disk again.
describe("the bytes a decode reads", () => {
  beforeEach(() => {
    libraw.transfers = [];
  });

  it("decodes from the bytes it is handed without reading the file", async () => {
    const file = dng([field(TIFF_TAG.WhiteLevel, TYPE.LONG, 255)], plane(51));
    const bytes = await file.arrayBuffer();
    const reads = vi.spyOn(file, "arrayBuffer");

    const image = await decodeRawToFloat(file, undefined, undefined, bytes);

    expect(reads).not.toHaveBeenCalled();
    expect("failure" in image ? image : image.data[0]).toBeCloseTo(51 / 255, 5);
  });

  it("gives up the bitmap decode without reading the file it was handed the bytes of", async () => {
    const file = new Blob(["raw"]);
    const reads = vi.spyOn(file, "arrayBuffer");

    expect(await decodeRawToBitmap(file, await new Blob(["raw"]).arrayBuffer())).toBeNull();
    expect(reads).not.toHaveBeenCalled();
  });

  it("hands libraw the bytes it read when the in-house path can't take the file", async () => {
    await decodeRawToFloat(new Blob(["raw"]));
    expect(libraw.transfers).toEqual([true]);
  });

  it("hands libraw a copy when the in-house path may need the bytes after it", async () => {
    await decodeRawToFloat(dng([], plane(51)));
    expect(libraw.transfers).toEqual([false]);
  });

  it("hands libraw a copy of bytes its caller keeps", async () => {
    const file = new Blob(["raw"]);
    await decodeRawToFloat(file, undefined, undefined, await file.arrayBuffer());
    expect(libraw.transfers).toEqual([false]);
  });

  it("reads through the reader it is handed, keeping the bytes for its caller", async () => {
    const file = new File(["raw"], "a.NEF");
    const reads = vi.spyOn(file, "arrayBuffer");
    const reader = vi.fn(() => new Blob(["raw"]).arrayBuffer());

    await decodeRawToFloat(file, undefined, undefined, reader);

    expect(reader).toHaveBeenCalledTimes(1);
    expect(reads).not.toHaveBeenCalled();
    expect(libraw.transfers).toEqual([false]);
  });

  it("never calls the reader of a file background work passes over", async () => {
    const file = new File(["raw"], "a.NEF");
    let open = () => {};
    libraw.gate = new Promise((resolve) => (open = resolve));
    const opened = decodeRawToFloat(file);
    const reader = vi.fn(() => file.arrayBuffer());

    const skipped = await decodeRawToFloat(file, { background: true }, undefined, reader);
    open();
    await opened;
    libraw.gate = Promise.resolve();

    expect(skipped).toMatchObject({ passedOver: true });
    expect(reader).not.toHaveBeenCalled();
  });
});

// Floating-point linear DNGs (HDR and panorama merges, denoised exports) are
// Deflate-compressed, which the bundled libraw can't read: the in-house linear
// DNG decoder leads for them, and stands in for libraw on integer ones.
describe("linear DNGs", () => {
  const linearDng = (name: string): File => {
    const bytes = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "linear-dng", `${name}.dng`));
    return new File([bytes], `${name}.dng`);
  };

  beforeEach(() => {
    libraw.background = [];
  });

  it("decodes a floating-point one without asking libraw", async () => {
    const image = await decodeRawToFloat(linearDng("f16-tiled-deflate"));
    if ("failure" in image) throw new Error(image.reason);
    expect([image.width, image.height, image.oriented]).toEqual([20, 12, true]);
    expect(image.data[0]).toBeCloseTo(1 / 64, 3);
    expect(libraw.background).toEqual([]);
  });

  it("turns it as asked, says so, and builds its cache entry", async () => {
    const image = await decodeRawToFloat(linearDng("f16-tiled-deflate"), { turn: 90, cacheEdge: 8 });
    if ("failure" in image) throw new Error(image.reason);
    expect([image.width, image.height, image.turned]).toEqual([12, 20, 90]);
    expect(image.entry).toBeDefined();
  });

  it("reports the as-shot white it balanced the frame by", async () => {
    const image = await decodeRawToFloat(linearDng("f32-strips-deflate-be"));
    if ("failure" in image) throw new Error(image.reason);
    expect(image.asShotMultipliers).toEqual([1, 1, 1]);
    expect(image.colorTemperature).toBe(6500);
  });

  it("decodes an integer one libraw couldn't", async () => {
    const image = await decodeRawToFloat(linearDng("u16-strips-deflate-pred2"));
    if ("failure" in image) throw new Error(image.reason);
    expect(libraw.background).toHaveLength(1);
    expect([image.width, image.height]).toEqual([20, 12]);
  });

  it("calls one too large to fit in memory even at half size unsupported for good", async () => {
    const side = 60_000;
    const { buffer } = buildTiffWithTrailer([
      {
        fields: [
          field(TIFF_TAG.ImageWidth, TYPE.LONG, side),
          field(TIFF_TAG.ImageLength, TYPE.LONG, side),
          field(TIFF_TAG.BitsPerSample, TYPE.SHORT, 16, 16, 16),
          field(TIFF_TAG.Compression, TYPE.SHORT, COMPRESSION.Deflate),
          field(TIFF_TAG.PhotometricInterpretation, TYPE.SHORT, PHOTOMETRIC_LINEAR_RAW),
          field(TIFF_TAG.StripOffsets, TYPE.LONG, 8),
          field(TIFF_TAG.SamplesPerPixel, TYPE.SHORT, 3),
          field(TIFF_TAG.RowsPerStrip, TYPE.LONG, side),
          field(TIFF_TAG.StripByteCounts, TYPE.LONG, 8),
          field(TIFF_TAG.SampleFormat, TYPE.SHORT, 3, 3, 3),
        ],
      },
    ]);
    const image = await decodeRawToFloat(new File([buffer], "huge.dng"));
    expect(image).toMatchObject({ failure: "unsupported", tooLarge: true });
    expect(libraw.background).toEqual([]);
  });

  it("decodes from bytes its caller keeps, leaving them intact", async () => {
    const file = linearDng("f32-uncompressed-crop");
    const bytes = await file.arrayBuffer();
    const image = await decodeRawToFloat(file, undefined, undefined, bytes);
    expect("failure" in image).toBe(false);
    expect(bytes.byteLength).toBe(file.size);
  });
});
