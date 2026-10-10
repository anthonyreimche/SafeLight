// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// When libraw gives no image, the adapter says whether the file was the
// problem (it read it and nothing usable came out: unsupported) or this page
// was (no worker, no instance, no memory: transient), so that only the first
// is remembered, and why, in libraw's words. The pool is faked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  metadata: {} as Record<string, unknown>,
  pixels: undefined as Uint16Array | undefined,
  openError: null as Error | null,
  /** Whether the pool has an instance to hand out. */
  available: true,
}));

vi.mock("./decode-pool", () => {
  const instance = {
    async open() {
      if (h.openError) throw h.openError;
    },
    async metadata() {
      return h.metadata;
    },
    async imageData() {
      return h.pixels;
    },
  };
  return {
    acquireInstance: async (request?: { signal?: AbortSignal }) =>
      h.available && !request?.signal?.aborted ? instance : null,
    releaseInstance: () => {},
    discardInstance: () => {},
  };
});

import { decodeRawFloatViaLibRaw } from "./libraw-wasm-adapter";

const MIB = 1024 * 1024;
const rawBytes = (size = 2 * MIB): ArrayBuffer => new ArrayBuffer(size);

beforeEach(() => {
  h.metadata = { width: 2, height: 2, color_data: { cam_mul: [1, 1, 1, 1] } };
  h.pixels = new Uint16Array(2 * 2 * 3).fill(12000);
  h.openError = null;
  h.available = true;
  vi.stubGlobal("Worker", class {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("decodeRawFloatViaLibRaw, a file it can't use", () => {
  it("is unsupported when libraw opens it but hands back no image", async () => {
    h.pixels = undefined;

    expect(await decodeRawFloatViaLibRaw(rawBytes())).toEqual({
      failure: "unsupported",
      reason: "imageData returned undefined (WASM error)",
    });
  });

  it("is unsupported when the frame has no size", async () => {
    h.metadata = { color_data: { cam_mul: [1, 1, 1, 1] } };

    expect(await decodeRawFloatViaLibRaw(rawBytes())).toEqual({
      failure: "unsupported",
      reason: "decoded but missing dimensions",
    });
  });

  it("is unsupported when the pixels don't fit the frame", async () => {
    h.pixels = new Uint16Array(3);

    expect(await decodeRawFloatViaLibRaw(rawBytes())).toEqual({
      failure: "unsupported",
      reason: "pixel/size mismatch (3 for 2x2)",
    });
  });

  it("is unsupported when the decode comes out blown and colour-imbalanced", async () => {
    h.pixels = new Uint16Array(2 * 2 * 3);
    for (let i = 0; i < h.pixels.length; i += 3) {
      h.pixels[i] = 65535;
      h.pixels[i + 1] = 65535;
      h.pixels[i + 2] = 50000;
    }

    expect(await decodeRawFloatViaLibRaw(rawBytes())).toEqual({
      failure: "unsupported",
      reason: expect.stringMatching(/^rejected: blown\+imbalanced R=/),
    });
  });

  it("is unsupported when the file is too small to hold a raw frame", async () => {
    expect(await decodeRawFloatViaLibRaw(rawBytes(1024))).toEqual({
      failure: "unsupported",
      reason: "file too small (1024 bytes)",
    });
  });
});

describe("decodeRawFloatViaLibRaw, a page that can't decode right now", () => {
  it("is transient without a Worker", async () => {
    vi.stubGlobal("Worker", undefined);

    expect(await decodeRawFloatViaLibRaw(rawBytes())).toEqual({
      failure: "transient",
      reason: "no Worker support",
    });
  });

  it("is transient without shared memory", async () => {
    vi.stubGlobal("SharedArrayBuffer", undefined);

    expect(await decodeRawFloatViaLibRaw(rawBytes())).toEqual({
      failure: "transient",
      reason: expect.stringMatching(/^no SharedArrayBuffer/),
    });
  });

  it("is transient when the pool has no instance", async () => {
    h.available = false;

    expect(await decodeRawFloatViaLibRaw(rawBytes())).toEqual({
      failure: "transient",
      reason: "decode pool unavailable",
    });
  });

  it("is transient when the page runs out of memory mid-decode", async () => {
    h.openError = new RangeError("Array buffer allocation failed");

    expect(await decodeRawFloatViaLibRaw(rawBytes())).toEqual({
      failure: "transient",
      reason: "decode error: Array buffer allocation failed",
    });
  });

  it("is aborted when the request was abandoned before an instance was free", async () => {
    const gone = new AbortController();
    gone.abort();

    expect(await decodeRawFloatViaLibRaw(rawBytes(), { signal: gone.signal })).toEqual({
      failure: "aborted",
    });
  });
});
