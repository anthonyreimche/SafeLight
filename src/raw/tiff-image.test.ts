// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The plain-TIFF decoder: the full image for Develop, and for a thumbnail the
// smallest reduced-resolution copy the file carries that is still big enough.
// Bitmaps are stand-ins carrying the size they were made at.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTiffWithTrailer, field, TYPE, type IfdSpec } from "./tiff.test-support";
import { decodeTiff, decodeTiffBuffer } from "./tiff-image";

const NEW_SUBFILE_TYPE = 0x00fe;
const REDUCED = 1;

interface Page {
  width: number;
  height: number;
  reduced?: boolean;
}

// An 8-bit RGB strip per page, laid out behind the IFDs.
function rgbTiff(pages: Page[], layout: (specs: IfdSpec[]) => void): ArrayBuffer {
  const specsAt = (pixelsAt: number): IfdSpec[] => {
    let offset = pixelsAt;
    return pages.map((p) => {
      const bytes = p.width * p.height * 3;
      const fields = [
        ...(p.reduced ? [field(NEW_SUBFILE_TYPE, TYPE.LONG, REDUCED)] : []),
        field(0x0100, TYPE.LONG, p.width),
        field(0x0101, TYPE.LONG, p.height),
        field(0x0102, TYPE.SHORT, 8, 8, 8),
        field(0x0103, TYPE.SHORT, 1),
        field(0x0106, TYPE.SHORT, 2),
        field(0x0111, TYPE.LONG, offset),
        field(0x0115, TYPE.SHORT, 3),
        field(0x0116, TYPE.LONG, p.height),
        field(0x0117, TYPE.LONG, bytes),
      ];
      offset += bytes;
      return { fields };
    });
  };
  const trailer = new Uint8Array(pages.reduce((n, p) => n + p.width * p.height * 3, 0)).fill(128);
  const probe = specsAt(0);
  layout(probe);
  const { trailerOffset } = buildTiffWithTrailer(probe, { trailer });
  const specs = specsAt(trailerOffset);
  layout(specs);
  return buildTiffWithTrailer(specs, { trailer }).buffer;
}

const asSubIfd = (specs: IfdSpec[]) => {
  specs[0].subIfds = [1];
};
const asNextPage = (specs: IfdSpec[]) => {
  specs[0].next = 1;
};

class FakeImageData {
  width: number;
  height: number;
  constructor(_data: Uint8ClampedArray, width: number, height: number) {
    this.width = width;
    this.height = height;
  }
}

beforeEach(() => {
  vi.stubGlobal("ImageData", FakeImageData);
  vi.stubGlobal("createImageBitmap", async (image: FakeImageData) => ({
    width: image.width,
    height: image.height,
    close() {},
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const FULL: Page = { width: 40, height: 30 };
const PREVIEW: Page = { width: 20, height: 15, reduced: true };

describe("decodeTiffBuffer", () => {
  it("decodes the full image when asked for no particular size", async () => {
    const r = await decodeTiffBuffer(rgbTiff([FULL, PREVIEW], asSubIfd));

    expect(r && { w: r.bitmap.width, h: r.bitmap.height }).toEqual({ w: 40, h: 30 });
  });

  it("thumbnails from a reduced-resolution SubIFD that is big enough", async () => {
    const r = await decodeTiffBuffer(rgbTiff([FULL, PREVIEW], asSubIfd), 16);

    expect(r && { w: r.bitmap.width, h: r.bitmap.height }).toEqual({ w: 20, h: 15 });
    expect(r && { width: r.width, height: r.height }).toEqual({ width: 40, height: 30 });
  });

  it("thumbnails from a reduced-resolution later page too", async () => {
    const r = await decodeTiffBuffer(rgbTiff([FULL, PREVIEW], asNextPage), 16);

    expect(r && { w: r.bitmap.width, h: r.bitmap.height }).toEqual({ w: 20, h: 15 });
  });

  it("decodes the full image when the reduced copy is too small", async () => {
    const r = await decodeTiffBuffer(rgbTiff([FULL, PREVIEW], asSubIfd), 32);

    expect(r && { w: r.bitmap.width, h: r.bitmap.height }).toEqual({ w: 40, h: 30 });
  });

  it("passes over a smaller page that isn't flagged reduced or has another shape", async () => {
    const other = rgbTiff([FULL, { width: 20, height: 15 }], asNextPage);
    const cropped = rgbTiff([FULL, { width: 20, height: 20, reduced: true }], asSubIfd);

    for (const buffer of [other, cropped]) {
      const r = await decodeTiffBuffer(buffer, 16);
      expect(r && { w: r.bitmap.width, h: r.bitmap.height }).toEqual({ w: 40, h: 30 });
    }
  });
});

describe("decodeTiff", () => {
  it("decodes the full image", async () => {
    const bitmap = await decodeTiff(new Blob([rgbTiff([FULL, PREVIEW], asSubIfd)]));

    expect(bitmap && { w: bitmap.width, h: bitmap.height }).toEqual({ w: 40, h: 30 });
  });

  it("is null for a file that isn't a TIFF", async () => {
    expect(await decodeTiff(new Blob([new Uint8Array(16)]))).toBeNull();
  });
});
