// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { afterEach, describe, it, expect, vi } from "vitest";
import {
  extractRawPreviewDecoded,
  findJpegEnd,
  jpegDimensions,
  sensorNativeJpeg,
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

// An Exif APP1 holding just its signature, and an APP1 that is XMP instead.
const EXIF_APP1 = bytes(0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00);
const XMP_APP1 = bytes(0xff, 0xe1, 0x00, 0x06, 0x68, 0x74, 0x74, 0x70); // "http…"

/** MINIMAL_JPEG with extra segments spliced in behind the SOI. */
function withSegments(...segments: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const parts = [MINIMAL_JPEG.subarray(0, 2), ...segments, MINIMAL_JPEG.subarray(2)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

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

describe("sensorNativeJpeg", () => {
  it("drops the Exif APP1 segment and keeps every other segment", async () => {
    const stripped = sensorNativeJpeg(withSegments(EXIF_APP1, XMP_APP1));
    expect(stripped.type).toBe("image/jpeg");
    expect(await bytesOf(stripped)).toEqual(withSegments(XMP_APP1));
  });

  it("leaves a JPEG without an Exif segment as it is", async () => {
    expect(await bytesOf(sensorNativeJpeg(MINIMAL_JPEG))).toEqual(MINIMAL_JPEG);
  });

  it("takes a JPEG embedded at an offset, within the range it is given", async () => {
    const tagged = withSegments(EXIF_APP1);
    const container = bytes(0x00, 0x01, 0x02, ...tagged, 0xff, 0xd8, 0xff);
    expect(await bytesOf(sensorNativeJpeg(container, 3, 3 + tagged.length))).toEqual(
      MINIMAL_JPEG,
    );
  });
});

describe("extractRawPreviewDecoded", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubBitmapDecoder(): {
    opts: (ImageBitmapOptions | undefined)[];
    blobs: Blob[];
  } {
    const seen: (ImageBitmapOptions | undefined)[] = [];
    const blobs: Blob[] = [];
    vi.stubGlobal(
      "createImageBitmap",
      async (b: Blob, opts?: ImageBitmapOptions): Promise<ImageBitmap> => {
        seen.push(opts);
        blobs.push(b);
        return {
          width: opts?.resizeWidth ?? 4000,
          height: opts?.resizeHeight ?? 3000,
          close() {},
        } as unknown as ImageBitmap;
      },
    );
    return { opts: seen, blobs };
  }

  it("hands the decoder the preview without its Exif segment, sized from the SOF header", async () => {
    const { opts, blobs } = stubBitmapDecoder();
    const d = await extractRawPreviewDecoded(new File([withSegments(EXIF_APP1)], "a.RAF"), {
      targetLongEdge: 640,
    });
    expect(await bytesOf(blobs[0])).toEqual(MINIMAL_JPEG);
    expect(await bytesOf(d!.blob)).toEqual(MINIMAL_JPEG);
    expect(opts[0]).toMatchObject({ resizeWidth: 640, resizeHeight: 480 });
    expect(d).toMatchObject({ width: 4000, height: 3000 });
  });

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
