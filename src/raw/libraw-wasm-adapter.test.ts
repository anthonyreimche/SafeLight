// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { kelvinFromWhiteBalanceGains } from "@/rendering/blackbody";

const h = vi.hoisted(() => ({
  /** What the pooled libraw instance answers from metadata(). */
  metadata: {} as Record<string, unknown>,
  /** Makes open() fail, the way an unsupported camera does. */
  openError: null as Error | null,
  /** Bytes handed to open(), in order. */
  opened: [] as Uint8Array[],
  acquired: 0,
  released: [] as unknown[],
}));

vi.mock("./decode-pool", () => {
  const instance = {
    async open(bytes: Uint8Array) {
      h.opened.push(bytes);
      if (h.openError) throw h.openError;
    },
    async metadata() {
      return h.metadata;
    },
    async imageData() {
      return undefined;
    },
  };
  return {
    acquireInstance: async () => {
      h.acquired++;
      return instance;
    },
    releaseInstance: (inst: unknown) => {
      h.released.push(inst);
    },
  };
});

import { extractRawMetadata } from "./libraw-wasm-adapter";

const MIB = 1024 * 1024;
const rawBytes = (size = 2 * MIB): ArrayBuffer => new ArrayBuffer(size);

beforeEach(() => {
  h.metadata = {};
  h.openError = null;
  h.opened = [];
  h.acquired = 0;
  h.released = [];
  // libraw runs in a Worker on shared memory; Node has the latter, not the former.
  vi.stubGlobal("Worker", class {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("extractRawMetadata", () => {
  it("reports the frame libraw decodes and the as-shot white balance", async () => {
    h.metadata = {
      width: 6240,
      height: 4160,
      raw_width: 6384,
      raw_height: 4182,
      color_data: { cam_mul: [2.1, 1, 1.6, 1] },
    };

    await expect(extractRawMetadata(rawBytes())).resolves.toEqual({
      frame: { width: 6240, height: 4160 },
      colorTemperature: kelvinFromWhiteBalanceGains(2.1, 1, 1.6),
    });
  });

  it("takes the frame as libraw reports it — a portrait shot comes back already upright", async () => {
    h.metadata = { width: 4160, height: 6240 };

    expect((await extractRawMetadata(rawBytes()))?.frame).toEqual({ width: 4160, height: 6240 });
  });

  it("never sizes the frame from the raw sensor readout", async () => {
    // raw_width/raw_height include the masked borders — larger than any image.
    h.metadata = { width: 0, height: 0, raw_width: 6384, raw_height: 4182 };

    expect((await extractRawMetadata(rawBytes()))?.frame).toBeUndefined();
  });

  it("leaves the white balance unset when libraw exposes no camera multipliers", async () => {
    h.metadata = { width: 10, height: 10, color_data: {} };

    const meta = await extractRawMetadata(rawBytes());

    expect(meta?.frame).toEqual({ width: 10, height: 10 });
    expect(meta?.colorTemperature).toBeUndefined();
  });

  it("answers undefined for a file libraw can't open, and still frees its slot", async () => {
    h.openError = new Error("LibRaw: open_buffer() failed with code -2");

    await expect(extractRawMetadata(rawBytes())).resolves.toBeUndefined();
    expect(h.released).toHaveLength(1);
  });

  it("frees the pooled instance after a successful read", async () => {
    h.metadata = { width: 1, height: 1 };

    await extractRawMetadata(rawBytes());

    expect(h.acquired).toBe(1);
    expect(h.released).toHaveLength(1);
  });

  it("skips a file below the size floor without touching the pool", async () => {
    await expect(extractRawMetadata(rawBytes(512 * 1024))).resolves.toBeUndefined();
    expect(h.acquired).toBe(0);
  });

  it("hands libraw a copy so the caller's buffer survives the transfer", async () => {
    const buffer = rawBytes();
    h.metadata = { width: 1, height: 1 };

    await extractRawMetadata(buffer);

    expect(h.opened[0].buffer).not.toBe(buffer);
    expect(h.opened[0].byteLength).toBe(buffer.byteLength);
  });
});
