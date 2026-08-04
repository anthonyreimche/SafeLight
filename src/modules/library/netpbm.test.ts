// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, it, expect, vi } from "vitest";
import { decodeNetpbm, isNetpbmName } from "./netpbm";
import { MAX_DECODE_PIXELS } from "./decode-limits";

// The decoder's last step hands its RGBA buffer to ImageData/createImageBitmap,
// which exist in the browser and in workers but not in Node. These stand-ins
// keep the buffer reachable so the decoded pixels can be asserted; the shape
// matches ImageBitmap so the decoder's return type still narrows.
class TestBitmap {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;

  constructor(data: Uint8ClampedArray, width: number, height: number) {
    this.data = data;
    this.width = width;
    this.height = height;
  }

  close(): void {}
}

vi.stubGlobal("ImageData", TestBitmap);
vi.stubGlobal("createImageBitmap", (image: TestBitmap) => Promise.resolve(image));

const bytes = (...b: number[]): Uint8Array<ArrayBuffer> => new Uint8Array(b);

// Header text and binary payloads are passed as separate parts so the sample
// bytes stay readable as numbers rather than escaped characters.
async function decode(
  ...parts: Array<string | Uint8Array<ArrayBuffer>>
): Promise<TestBitmap | null> {
  return (await decodeNetpbm(new Blob(parts))) as TestBitmap | null;
}

function pixels(image: TestBitmap): number[] {
  return Array.from(image.data);
}

const WHITE = 255;
const BLACK = 0;

describe("isNetpbmName", () => {
  it("accepts the four Netpbm extensions in any case", () => {
    expect(isNetpbmName("scan.ppm")).toBe(true);
    expect(isNetpbmName("scan.PGM")).toBe(true);
    expect(isNetpbmName("scan.Pbm")).toBe(true);
    expect(isNetpbmName("scan.pnm")).toBe(true);
  });

  it("rejects other names", () => {
    expect(isNetpbmName("scan.jpg")).toBe(false);
    expect(isNetpbmName("ppm")).toBe(false);
    expect(isNetpbmName("scan.ppm.jpg")).toBe(false);
    expect(isNetpbmName("")).toBe(false);
  });
});

describe("decodeNetpbm bitmaps", () => {
  // 3x2 checker: row 0 = black/white/black, row 1 = white/black/white.
  const checker = [
    BLACK, BLACK, BLACK, 255, WHITE, WHITE, WHITE, 255, BLACK, BLACK, BLACK, 255,
    WHITE, WHITE, WHITE, 255, BLACK, BLACK, BLACK, 255, WHITE, WHITE, WHITE, 255,
  ];

  it("decodes P1 with 1 meaning black", async () => {
    const image = await decode("P1\n3 2\n101\n010\n");
    expect(image).not.toBeNull();
    expect(pixels(image as TestBitmap)).toEqual(checker);
  });

  it("decodes P4 as MSB-first bits with rows padded to whole bytes", async () => {
    // 3 px/row -> 1 byte/row, the low 5 bits are padding the decoder must skip.
    const image = await decode("P4\n3 2\n", bytes(0b10100000, 0b01000000));
    expect(image).not.toBeNull();
    expect(pixels(image as TestBitmap)).toEqual(checker);
  });

  it("returns null when a P4 row is missing", async () => {
    expect(await decode("P4\n3 2\n", bytes(0b10100000))).toBeNull();
  });

  it("returns null for a P1 sample that is neither 0 nor 1", async () => {
    expect(await decode("P1\n2 1\n2 0\n")).toBeNull();
  });
});

describe("decodeNetpbm grayscale", () => {
  it("decodes P2 and rescales from the declared maxval", async () => {
    const image = await decode("P2\n2 2\n15\n0 5 10 15\n");
    expect(image).not.toBeNull();
    expect(pixels(image as TestBitmap)).toEqual([
      0, 0, 0, 255, 85, 85, 85, 255, 170, 170, 170, 255, 255, 255, 255, 255,
    ]);
  });

  it("decodes P5 at 8 bits per sample", async () => {
    const image = await decode("P5\n2 2\n255\n", bytes(0, 85, 170, 255));
    expect(image).not.toBeNull();
    expect(pixels(image as TestBitmap)).toEqual([
      0, 0, 0, 255, 85, 85, 85, 255, 170, 170, 170, 255, 255, 255, 255, 255,
    ]);
  });

  it("decodes P5 at 16 bits per sample, big-endian, scaled to 8-bit", async () => {
    const image = await decode(
      "P5\n2 2\n65535\n",
      bytes(0x00, 0x00, 0x40, 0x00, 0x80, 0x00, 0xff, 0xff),
    );
    expect(image).not.toBeNull();
    expect(pixels(image as TestBitmap)).toEqual([
      0, 0, 0, 255, 64, 64, 64, 255, 128, 128, 128, 255, 255, 255, 255, 255,
    ]);
  });

  it("returns null when the ASCII samples run out", async () => {
    expect(await decode("P2\n2 2\n255\n1 2\n")).toBeNull();
  });

  it("returns null when the binary samples run out", async () => {
    expect(await decode("P5\n2 2\n255\n", bytes(1, 2, 3))).toBeNull();
  });
});

describe("decodeNetpbm colour", () => {
  it("decodes P3", async () => {
    const image = await decode("P3\n2 1\n255\n255 0 0  0 128 255\n");
    expect(image).not.toBeNull();
    expect(pixels(image as TestBitmap)).toEqual([255, 0, 0, 255, 0, 128, 255, 255]);
  });

  it("decodes P6", async () => {
    const image = await decode("P6\n2 1\n255\n", bytes(255, 0, 0, 0, 128, 255));
    expect(image).not.toBeNull();
    expect(pixels(image as TestBitmap)).toEqual([255, 0, 0, 255, 0, 128, 255, 255]);
  });

  it("decodes 16-bit P6 samples big-endian", async () => {
    const image = await decode("P6\n1 1\n65535\n", bytes(0xff, 0xff, 0x00, 0x00, 0x80, 0x00));
    expect(image).not.toBeNull();
    expect(pixels(image as TestBitmap)).toEqual([255, 0, 128, 255]);
  });

  it("returns null when 16-bit binary data is half a sample short", async () => {
    expect(await decode("P6\n1 1\n65535\n", bytes(0xff, 0xff, 0x00, 0x00, 0x80))).toBeNull();
  });
});

describe("decodeNetpbm header parsing", () => {
  it("skips comments and arbitrary whitespace between header fields", async () => {
    const image = await decode(
      "P3\t# written by a scanner\n\n  2 \r\n 1 \n# maxval follows\n255\n1 2 3 4 5 6\n",
    );
    expect(image).not.toBeNull();
    expect(pixels(image as TestBitmap)).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
  });

  it("skips a comment placed directly after the magic", async () => {
    const image = await decode("P2 #note\n1 1\n255\n42\n");
    expect(image).not.toBeNull();
    expect(pixels(image as TestBitmap)).toEqual([42, 42, 42, 255]);
  });

  it("consumes exactly one whitespace byte before binary data", async () => {
    // A leading 0x00 sample would be swallowed if the decoder skipped more.
    const image = await decode("P5 1 2 255 ", bytes(0x00, 0x7f));
    expect(image).not.toBeNull();
    expect(pixels(image as TestBitmap)).toEqual([0, 0, 0, 255, 127, 127, 127, 255]);
  });

  it("treats a CRLF header terminator as one separator", async () => {
    const image = await decode("P5\r\n2 2\r\n255\r\n", bytes(1, 2, 3, 4));
    expect(image).not.toBeNull();
    expect(pixels(image as TestBitmap)).toEqual([
      1, 1, 1, 255, 2, 2, 2, 255, 3, 3, 3, 255, 4, 4, 4, 255,
    ]);
  });

  it("keeps a first sample whose value is itself a newline", async () => {
    const image = await decode("P5\n1 1\n255\n", bytes(0x0a));
    expect(image).not.toBeNull();
    expect(pixels(image as TestBitmap)).toEqual([10, 10, 10, 255]);
  });
});

describe("decodeNetpbm rejects malformed input", () => {
  it("rejects buffers that are not Netpbm at all", async () => {
    expect(await decode("")).toBeNull();
    expect(await decode("P")).toBeNull();
    expect(await decode(bytes(0xff, 0xd8, 0xff, 0xe0))).toBeNull();
    expect(await decode("P7\nWIDTH 2\n")).toBeNull();
    expect(await decode("p6\n2 2\n255\n")).toBeNull();
  });

  it("rejects unusable dimensions", async () => {
    expect(await decode("P6\n0 2\n255\n")).toBeNull();
    expect(await decode("P6\n2 -1\n255\n")).toBeNull();
    expect(await decode("P6\nwide 2\n255\n")).toBeNull();
    expect(await decode("P6\n2.5 2\n255\n")).toBeNull();
    expect(await decode("P6\n")).toBeNull();
  });

  it("rejects maxvals outside 1..65535", async () => {
    expect(await decode("P5\n2 2\n0\n", bytes(1, 2, 3, 4))).toBeNull();
    expect(await decode("P5\n2 2\n65536\n", bytes(1, 2, 3, 4))).toBeNull();
    expect(await decode("P5\n2 2\nmax\n", bytes(1, 2, 3, 4))).toBeNull();
  });

  it("rejects ASCII samples that are not whole numbers", async () => {
    expect(await decode("P2\n2 1\n255\nab cd\n")).toBeNull();
    expect(await decode("P2\n1 1\n255\n1.5\n")).toBeNull();
    expect(await decode("P3\n1 1\n255\n255 x 0\n")).toBeNull();
  });

  it("rejects headers claiming more pixels than the decode guard allows", async () => {
    const side = Math.ceil(Math.sqrt(MAX_DECODE_PIXELS)) + 1;
    expect(await decode(`P5\n${side} ${side}\n255\n`)).toBeNull();
  });
});
