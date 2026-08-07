// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The worker-side import pixel task: decode → orient → thumbnail encode for
// the formats the fast path covers. Bitmaps are stand-ins carrying geometry
// (as in import-photos.test), so the baked rotation and the true-frame-size
// bookkeeping are observable from the returned thumbnail and dimensions.

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { runThumbTask, type ThumbTaskInput } from "./import-thumb-task";

const bytes = (...b: number[]) => new Uint8Array(b);

// A complete minimal baseline JPEG: 4000×3000 SOF0, one entropy pair, EOI.
const MINIMAL_JPEG = bytes(
  0xff, 0xd8,
  0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
  0xff, 0xc0, 0x00, 0x0b,
  0x08, 0x0b, 0xb8, 0x0f, 0xa0,
  0x01, 0x01, 0x11, 0x00,
  0xff, 0xda, 0x00, 0x02, 0x11, 0x22,
  0xff, 0xd9,
);

function bitmapOf(width: number, height: number): ImageBitmap {
  return { width, height, close() {} } as unknown as ImageBitmap;
}

class FakeOffscreenCanvas {
  width: number;
  height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
  getContext() {
    return { translate() {}, rotate() {}, drawImage() {} };
  }
  async convertToBlob({ type }: { type: string }) {
    return new Blob([`jpeg:${this.width}x${this.height}`], { type });
  }
}

beforeEach(() => {
  vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
  vi.stubGlobal(
    "createImageBitmap",
    async (source: unknown, opts?: ImageBitmapOptions): Promise<ImageBitmap> => {
      if (source instanceof FakeOffscreenCanvas)
        return bitmapOf(source.width, source.height);
      if (opts?.resizeWidth) return bitmapOf(opts.resizeWidth, opts.resizeHeight!);
      if (source instanceof File) return bitmapOf(800, 600); // non-JPEG image
      return bitmapOf(4000, 3000); // embedded JPEG candidate, unresized
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function input(over: Partial<ThumbTaskInput> = {}): ThumbTaskInput {
  return {
    buffer: MINIMAL_JPEG.slice().buffer,
    name: "a.NEF",
    type: "",
    lastModified: 1_600_000_000_000,
    orientation: undefined,
    previewSource: "auto",
    thumbMaxEdge: 640,
    ...over,
  };
}

const thumbTag = async (thumb: Blob) => thumb.text();

describe("runThumbTask — RAW embedded previews", () => {
  it("accepts a grid-sized preview: downscaled decode, true frame size", async () => {
    const r = await runThumbTask(input());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect({ width: r.width, height: r.height }).toEqual({ width: 4000, height: 3000 });
    await expect(thumbTag(r.thumb)).resolves.toBe("jpeg:640x480");
  });

  it("orients a sensor-native preview from the master EXIF quarter turn", async () => {
    const r = await runThumbTask(input({ orientation: 6 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect({ width: r.width, height: r.height }).toEqual({ width: 3000, height: 4000 });
    await expect(thumbTag(r.thumb)).resolves.toBe("jpeg:480x640");
  });

  it("declines when the preview is too small for auto mode", async () => {
    const r = await runThumbTask(input({ thumbMaxEdge: 8000 }));
    expect(r).toEqual({ ok: false });
  });

  it("accepts a small preview outright in embedded mode", async () => {
    const r = await runThumbTask(
      input({ previewSource: "embedded", thumbMaxEdge: 8000 }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.width).toBe(4000);
    await expect(thumbTag(r.thumb)).resolves.toBe("jpeg:4000x3000");
  });

  it("declines rendered mode and distrusted formats", async () => {
    expect(await runThumbTask(input({ previewSource: "rendered" }))).toEqual({ ok: false });
    expect(await runThumbTask(input({ name: "a.crw" }))).toEqual({ ok: false });
  });

  it("declines when the file holds no decodable preview", async () => {
    const r = await runThumbTask(input({ buffer: bytes(1, 2, 3, 4).buffer }));
    expect(r).toEqual({ ok: false });
  });
});

describe("runThumbTask — plain images", () => {
  it("decodes a JPEG straight to thumbnail scale and bakes the EXIF turn", async () => {
    const r = await runThumbTask(
      input({ name: "b.jpg", type: "image/jpeg", orientation: 8 }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect({ width: r.width, height: r.height }).toEqual({ width: 3000, height: 4000 });
    await expect(thumbTag(r.thumb)).resolves.toBe("jpeg:480x640");
  });

  it("decodes a non-JPEG image at full size", async () => {
    const r = await runThumbTask(
      input({ buffer: bytes(1, 2, 3, 4).buffer, name: "c.png", type: "image/png" }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect({ width: r.width, height: r.height }).toEqual({ width: 800, height: 600 });
    await expect(thumbTag(r.thumb)).resolves.toBe("jpeg:640x480");
  });
});
