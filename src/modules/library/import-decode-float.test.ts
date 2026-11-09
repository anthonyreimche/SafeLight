// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A RAW thumbnail rendered from the sensor: the float decode stops at half size
// when the thumbnail needs no more, and the 8-bit encode runs off the main
// thread. The decoders and the frame worker are faked.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RawFloatImage } from "@/raw/decode";
import type { DecodeRequest } from "@/raw/decode-pool";

const h = vi.hoisted(() => ({
  requests: [] as (DecodeRequest | undefined)[],
  decode: null as RawFloatImage | null,
  /** The float frames handed to the 8-bit encode, in order. */
  encoded: [] as Float32Array[],
  /** The ImageData the bitmap was made from: its bytes and size. */
  images: [] as { data: Uint8ClampedArray; width: number; height: number }[],
}));

vi.mock("@/raw/decode", () => ({
  decodeRawToBitmap: async () => null,
  decodeRawToFloat: async (_file: Blob, request?: DecodeRequest) => {
    h.requests.push(request);
    return h.decode;
  },
}));

vi.mock("@/raw/frame-bridge", () => ({
  encodeSrgb8: async (data: Float32Array) => {
    h.encoded.push(data);
    return new Uint8ClampedArray(data.length).fill(9);
  },
}));

vi.mock("@/raw/raw-preview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/raw/raw-preview")>()),
  extractRawPreviewDecoded: async () => null,
}));

vi.mock("./import-thumb-pool", () => ({ processThumb: async () => ({ ok: false }) }));

vi.mock("@/state/settings-store", () => ({
  getSettings: () => ({ previewSource: "rendered", thumbMaxEdge: 640 }),
}));

import { decodeImportBitmap } from "./import-decode";

class FakeImageData {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;

  constructor(data: Uint8ClampedArray, width: number, height: number) {
    this.data = data;
    this.width = width;
    this.height = height;
    h.images.push({ data, width, height });
  }
}

const rawFile = new File([new Uint8Array(8)], "DSC_0001.NEF");

const frame = (over: Partial<RawFloatImage> = {}): RawFloatImage => ({
  data: new Float32Array(3 * 2 * 4).fill(0.18),
  width: 3,
  height: 2,
  oriented: true,
  ...over,
});

beforeEach(() => {
  h.requests = [];
  h.decode = frame();
  h.encoded = [];
  h.images = [];
  vi.stubGlobal("ImageData", FakeImageData);
  vi.stubGlobal("createImageBitmap", async (image: FakeImageData) => ({ width: image.width, height: image.height, close() {} }));
});

describe("decodeImportBitmap, a RAW rendered from the sensor", () => {
  it("lets the decode stop at half size when the thumbnail is no larger than that", async () => {
    await decodeImportBitmap(rawFile, undefined);

    expect(h.requests[0]?.targetEdge).toBe(640);
  });

  it("keeps the request's priority and signal", async () => {
    const signal = new AbortController().signal;

    await decodeImportBitmap(rawFile, undefined, { background: true, signal });

    expect(h.requests[0]).toMatchObject({ background: true, signal, targetEdge: 640 });
  });

  it("makes the thumbnail's bitmap from the bytes the frame worker encoded", async () => {
    const decoded = frame();

    const out = await decodeImportBitmap(rawFile, undefined);

    expect(h.encoded).toEqual([decoded.data]);
    expect(h.images).toHaveLength(1);
    expect([h.images[0].width, h.images[0].height]).toEqual([3, 2]);
    expect(Array.from(h.images[0].data.slice(0, 4))).toEqual([9, 9, 9, 9]);
    expect(out).toMatchObject({ oriented: true, bitmap: { width: 3, height: 2 } });
  });

  it("reports the full frame's size for a half-size decode, as the bitmap stands for it", async () => {
    h.decode = frame({ halfSize: true, sourceWidth: 6, sourceHeight: 4 });

    const out = await decodeImportBitmap(rawFile, undefined);

    expect(out).toMatchObject({ sourceWidth: 6, sourceHeight: 4 });
  });

  it("reports no source size for a full-size decode", async () => {
    const out = await decodeImportBitmap(rawFile, undefined);

    expect(out).not.toHaveProperty("sourceWidth");
  });
});
