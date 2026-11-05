// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A frame too big for libraw's 2 GiB heap at full size is decoded at half
// size, and says so; one that runs the heap out even then counts as
// unsupported, so it isn't decoded again on every open. The pool is faked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  metadata: {} as Record<string, unknown>,
  /** Settings handed to open(), in order. */
  settings: [] as (Record<string, unknown> | undefined)[],
  /** Bytes handed to open(), in order. */
  opened: [] as Uint8Array[],
  /** What imageData() rejects with, as libraw's worker does: its message. */
  imageError: null as unknown,
}));

vi.mock("./decode-pool", () => {
  const instance = {
    async open(bytes: Uint8Array, settings?: Record<string, unknown>) {
      h.opened.push(bytes);
      h.settings.push(settings);
    },
    async metadata() {
      return h.metadata;
    },
    async imageData() {
      if (h.imageError !== null) throw h.imageError;
      const half = h.settings[h.settings.length - 1]?.halfSize === true;
      const width = half ? 2 : 4;
      return { data: new Uint16Array(width * 2 * 3).fill(12000), width, height: 2 };
    },
  };
  return {
    acquireInstance: async () => instance,
    decodePoolFailure: () => undefined,
    releaseInstance: () => {},
    discardInstance: () => {},
  };
});

import { decodeRawFloatViaLibRaw } from "./libraw-wasm-adapter";
import type { RawFloatImage } from "./decode-result";

const MIB = 1024 * 1024;

// A Phase One IQ4 150MP frame: about 2.4 GB at full size, past the heap.
const HUGE = { width: 14204, height: 10652 };
// A 45 MP frame, which fits with room to spare.
const ORDINARY = { width: 8192, height: 5464 };
// A GFX100-class 102 MP frame: about 1.6 GB at full size, still under the heap.
const GFX100 = { width: 11648, height: 8736 };

beforeEach(() => {
  h.metadata = { ...ORDINARY, color_data: { cam_mul: [1, 1, 1, 1] } };
  h.settings = [];
  h.opened = [];
  h.imageError = null;
  vi.stubGlobal("Worker", class {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("decodeRawFloatViaLibRaw, a frame past libraw's heap", () => {
  it("decodes an ordinary frame at full size, opening it once", async () => {
    const r = await decodeRawFloatViaLibRaw(new ArrayBuffer(2 * MIB));

    expect(h.settings).toHaveLength(1);
    expect(h.settings[0]?.halfSize).toBeUndefined();
    expect(r).toMatchObject({ width: 4, height: 2 });
    expect((r as RawFloatImage).halfSize).toBeUndefined();
  });

  it("decodes a 102 MP frame at full size", async () => {
    h.metadata = { ...h.metadata, ...GFX100 };

    const r = await decodeRawFloatViaLibRaw(new ArrayBuffer(2 * MIB));

    expect(h.settings).toHaveLength(1);
    expect(h.settings[0]?.halfSize).toBeUndefined();
    expect((r as RawFloatImage).halfSize).toBeUndefined();
  });

  it("asks for half size once the frame says it won't fit", async () => {
    h.metadata = { ...h.metadata, ...HUGE };

    const r = await decodeRawFloatViaLibRaw(new ArrayBuffer(2 * MIB));

    expect(h.settings.at(-1)?.halfSize).toBe(true);
    expect(r).toMatchObject({ width: 2, height: 2, halfSize: true });
  });

  it("hands a large frame that fits its buffer without a copy", async () => {
    h.metadata = { ...h.metadata, ...GFX100 };
    const buffer = new ArrayBuffer(64 * MIB);

    await decodeRawFloatViaLibRaw(buffer, undefined, true, async () => new ArrayBuffer(64 * MIB));

    expect(h.opened).toHaveLength(1);
    expect(h.opened[0].buffer === buffer).toBe(true);
  });

  it("reads the file again for the half-size reopen of a buffer it was handed", async () => {
    h.metadata = { ...h.metadata, ...HUGE };
    const buffer = new ArrayBuffer(64 * MIB);
    const again = new ArrayBuffer(64 * MIB);

    await decodeRawFloatViaLibRaw(buffer, undefined, true, async () => again);

    expect(h.opened).toHaveLength(2);
    expect(h.opened[0].buffer === buffer).toBe(true);
    expect(h.opened[1].buffer === again).toBe(true);
    expect(h.settings.at(-1)?.halfSize).toBe(true);
  });

  it("reopens a buffer it was not handed from that buffer", async () => {
    h.metadata = { ...h.metadata, ...HUGE };
    const buffer = new ArrayBuffer(64 * MIB);

    await decodeRawFloatViaLibRaw(buffer);

    expect(h.opened).toHaveLength(2);
    expect(h.opened[0].buffer).not.toBe(buffer);
    expect(h.opened[1].buffer).not.toBe(buffer);
    expect(h.settings.at(-1)?.halfSize).toBe(true);
  });

  it("calls a handed buffer's out-of-memory transient when half size could not be tried", async () => {
    h.metadata = { ...h.metadata, ...HUGE };
    h.imageError = "Aborted(OOM). Build with -sASSERTIONS for more info.";

    const r = await decodeRawFloatViaLibRaw(new ArrayBuffer(64 * MIB), undefined, true);

    expect(h.settings.some((s) => s?.halfSize)).toBe(false);
    expect(r).toMatchObject({ failure: "transient" });
    expect(r).not.toHaveProperty("tooLarge");
  });

  it("counts a half-size decode that still runs out of memory as too large", async () => {
    h.metadata = { ...h.metadata, ...HUGE };
    h.imageError = "Aborted(OOM). Build with -sASSERTIONS for more info.";

    expect(await decodeRawFloatViaLibRaw(new ArrayBuffer(2 * MIB))).toEqual({
      failure: "unsupported",
      tooLarge: true,
      reason: expect.stringMatching(/^too large to decode \(14204×10652\)/),
    });
  });

  it("counts this page running out of memory for such a frame as too large", async () => {
    h.metadata = { ...h.metadata, ...HUGE };
    h.imageError = new RangeError("Array buffer allocation failed");

    expect(await decodeRawFloatViaLibRaw(new ArrayBuffer(2 * MIB))).toMatchObject({
      failure: "unsupported",
      tooLarge: true,
    });
  });

  it("leaves running out of memory on a frame that fits as transient", async () => {
    h.imageError = new RangeError("Array buffer allocation failed");

    expect(await decodeRawFloatViaLibRaw(new ArrayBuffer(2 * MIB))).toEqual({
      failure: "transient",
      reason: "decode error: Array buffer allocation failed",
    });
  });
});
