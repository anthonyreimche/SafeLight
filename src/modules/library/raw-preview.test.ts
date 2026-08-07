// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { afterEach, describe, it, expect, vi } from "vitest";
import {
  extractRawPreviewDecoded,
  findJpegEnd,
  jpegDimensions,
} from "./raw-preview";

// Helper: assemble bytes from a flat list of numbers.
const bytes = (...b: number[]) => new Uint8Array(b);

// A complete minimal baseline JPEG: 4000×3000 SOF0, one entropy pair, EOI.
const MINIMAL_JPEG = bytes(
  0xff, 0xd8,                                     // SOI
  0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,             // APP0 len=4
  0xff, 0xc0, 0x00, 0x0b,                         // SOF0 len=11
  0x08, 0x0b, 0xb8, 0x0f, 0xa0,                   // precision 8, h=3000, w=4000
  0x01, 0x01, 0x11, 0x00,                         // 1 component
  0xff, 0xda, 0x00, 0x02, 0x11, 0x22,             // SOS + entropy
  0xff, 0xd9,                                     // EOI
);

describe("findJpegEnd", () => {
  it("returns the end of a minimal baseline JPEG", () => {
    // SOI | SOS len=2 | entropy 11 22 | EOI
    const buf = bytes(0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9);
    expect(findJpegEnd(buf, 0)).toBe(buf.length);
  });

  it("skips a nested EXIF thumbnail and returns the OUTER EOI", () => {
    // The bug this guards against: a naive FF-D9 search stops at the inner
    // thumbnail's EOI (index 10) and truncates the preview. The marker walk must
    // skip the APP1 segment (incl. its nested SOI…EOI) and return the outer EOI.
    const buf = bytes(
      0xff, 0xd8,                          // outer SOI
      0xff, 0xe1, 0x00, 0x06, 0xff, 0xd8, 0xff, 0xd9, // APP1 len=6 w/ nested SOI+EOI
      0xff, 0xda, 0x00, 0x02,              // SOS
      0x11, 0x22,                          // entropy data
      0xff, 0xd9,                          // outer EOI
    );
    const innerEoi = 10; // where the naive scan would have stopped
    const end = findJpegEnd(buf, 0);
    expect(end).toBe(buf.length);
    expect(end).toBeGreaterThan(innerEoi);
  });

  it("treats FF00 stuffing and restart markers as entropy, not EOI", () => {
    // SOS entropy containing a stuffed FF00 and a restart marker FF D0.
    const buf = bytes(
      0xff, 0xd8,
      0xff, 0xda, 0x00, 0x02,
      0x11, 0xff, 0x00, 0x22, 0xff, 0xd0, 0x33, // FF00 stuffing + RST0
      0xff, 0xd9,
    );
    expect(findJpegEnd(buf, 0)).toBe(buf.length);
  });

  it("returns -1 for a truncated stream with no EOI", () => {
    const buf = bytes(0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0x11, 0x22);
    expect(findJpegEnd(buf, 0)).toBe(-1);
  });
});

describe("jpegDimensions", () => {
  it("reads the frame size from the SOF header without decoding", () => {
    expect(jpegDimensions(MINIMAL_JPEG, 0)).toEqual({ width: 4000, height: 3000 });
  });

  it("returns null when the scan data starts before any SOF", () => {
    const buf = bytes(0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0x11, 0xff, 0xd9);
    expect(jpegDimensions(buf, 0)).toBeNull();
  });
});

describe("extractRawPreviewDecoded", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubBitmapDecoder(): { opts: (ImageBitmapOptions | undefined)[] } {
    const seen: (ImageBitmapOptions | undefined)[] = [];
    vi.stubGlobal(
      "createImageBitmap",
      async (_b: Blob, opts?: ImageBitmapOptions): Promise<ImageBitmap> => {
        seen.push(opts);
        return {
          width: opts?.resizeWidth ?? 4000,
          height: opts?.resizeHeight ?? 3000,
          close() {},
        } as unknown as ImageBitmap;
      },
    );
    return { opts: seen };
  }

  it("decodes straight to the target size and reports the true frame size", async () => {
    const { opts } = stubBitmapDecoder();
    const d = await extractRawPreviewDecoded(new File([MINIMAL_JPEG], "a.NEF"), {
      targetLongEdge: 640,
    });
    expect(opts[0]).toMatchObject({
      imageOrientation: "none",
      resizeWidth: 640,
      resizeHeight: 480,
    });
    expect(d).toMatchObject({ width: 4000, height: 3000 });
    expect(d?.bitmap.width).toBe(640);
  });

  it("skips resizing when the frame is already at or below the target", async () => {
    const { opts } = stubBitmapDecoder();
    const d = await extractRawPreviewDecoded(new File([MINIMAL_JPEG], "a.NEF"), {
      targetLongEdge: 8000,
    });
    expect(opts[0]).not.toHaveProperty("resizeWidth");
    expect(d).toMatchObject({ width: 4000, height: 3000 });
    expect(d?.bitmap.width).toBe(4000);
  });

  it("decodes at full size when no target is given (load-image path)", async () => {
    const { opts } = stubBitmapDecoder();
    const d = await extractRawPreviewDecoded(new File([MINIMAL_JPEG], "a.NEF"));
    expect(opts[0]).not.toHaveProperty("resizeWidth");
    expect(d?.bitmap.width).toBe(4000);
  });
});
