// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A caller that renders from a given long edge lets libraw decode at half size
// when half the frame still reaches it, and the frame's pixel work (turning it
// upright, the cache entry) is done as it is converted. The pool is faked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  metadata: {} as Record<string, unknown>,
  /** Settings handed to open(), in order. */
  settings: [] as (Record<string, unknown> | undefined)[],
  /** Bytes handed to open(), in order. */
  opened: [] as Uint8Array[],
  /** libraw hands back the full-size frame even when it was asked for half. */
  ignoresHalfSize: false,
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
      const half = h.settings[h.settings.length - 1]?.halfSize === true && !h.ignoresHalfSize;
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

const frame = (width: number, height: number) => {
  h.metadata = { width, height, color_data: { cam_mul: [1, 1, 1, 1] } };
};

async function decode(request: Parameters<typeof decodeRawFloatViaLibRaw>[1]): Promise<RawFloatImage> {
  const r = await decodeRawFloatViaLibRaw(new ArrayBuffer(2 * MIB), request);
  if ("failure" in r) throw new Error(`no image: ${r.failure}`);
  return r;
}

const lastSettings = () => h.settings.at(-1);

beforeEach(() => {
  h.settings = [];
  h.opened = [];
  h.ignoresHalfSize = false;
  frame(6000, 4000);
  vi.stubGlobal("Worker", class {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("decodeRawFloatViaLibRaw with a target edge", () => {
  it("decodes at half size when half the long edge still reaches the target", async () => {
    frame(6144, 4096);

    const r = await decode({ targetEdge: 3072 });

    expect(h.settings).toHaveLength(2);
    expect(lastSettings()?.halfSize).toBe(true);
    expect(r).toMatchObject({ width: 2, height: 2, halfSize: true, sourceWidth: 6144, sourceHeight: 4096 });
  });

  it("reaches the target exactly with half a frame of 8192 and a target of 4096", async () => {
    frame(8192, 5464);

    await decode({ targetEdge: 4096 });

    expect(lastSettings()?.halfSize).toBe(true);
  });

  it("decodes at full size when half the long edge falls short by a pixel", async () => {
    frame(6143, 4096);

    const r = await decode({ targetEdge: 3072 });

    expect(h.settings).toHaveLength(1);
    expect(lastSettings()?.halfSize).toBeUndefined();
    expect(r.halfSize).toBeUndefined();
  });

  it("decodes a 24 MP frame at full size for the defaults", async () => {
    await decode({ targetEdge: 3072 });
    expect(lastSettings()?.halfSize).toBeUndefined();

    await decode({ targetEdge: 4096 });
    expect(lastSettings()?.halfSize).toBeUndefined();
  });

  it("measures a portrait frame by its long side", async () => {
    frame(4096, 6144);

    await decode({ targetEdge: 3072 });

    expect(lastSettings()?.halfSize).toBe(true);
  });

  it("decodes at full size when no target is given", async () => {
    frame(9504, 6336);

    const r = await decode(undefined);

    expect(h.settings).toHaveLength(1);
    expect(r.halfSize).toBeUndefined();
  });

  it("reads the file again for the half-size reopen of a buffer it was handed", async () => {
    frame(6144, 4096);
    const buffer = new ArrayBuffer(2 * MIB);
    const again = new ArrayBuffer(2 * MIB);

    await decodeRawFloatViaLibRaw(buffer, { targetEdge: 3072 }, true, async () => again);

    expect(h.opened[0].buffer === buffer).toBe(true);
    expect(h.opened[1].buffer === again).toBe(true);
  });

  it("decodes at full size when the buffer was handed over and cannot be read again", async () => {
    frame(6144, 4096);

    const r = await decodeRawFloatViaLibRaw(new ArrayBuffer(2 * MIB), { targetEdge: 3072 }, true);

    expect(h.settings).toHaveLength(1);
    expect(r).not.toHaveProperty("halfSize");
  });

  it("does not call a frame half size when libraw returned it whole", async () => {
    frame(6144, 4096);
    h.ignoresHalfSize = true;
    h.metadata = { ...h.metadata, width: 4, height: 2 };

    const r = await decode({ targetEdge: 1 });

    expect(lastSettings()?.halfSize).toBe(true);
    expect(r.halfSize).toBeUndefined();
    expect(r.sourceWidth).toBeUndefined();
  });
});

describe("decodeRawFloatViaLibRaw's frame work", () => {
  it("bakes the turn it was asked for into the frame and says so", async () => {
    const r = await decode({ turn: 90 });

    expect(r).toMatchObject({ width: 2, height: 4, turned: 90 });
  });

  it("leaves an unturned frame's size alone, saying nothing of a turn", async () => {
    const r = await decode({});

    expect(r).toMatchObject({ width: 4, height: 2 });
    expect(r.turned).toBeUndefined();
  });

  it("builds the cache entry when asked", async () => {
    const r = await decode({ cacheEdge: 3072, turn: 270 });

    expect(r.entry).toMatchObject({ fullWidth: 2, fullHeight: 4 });
    expect(r.entry?.preview).toMatchObject({ width: 2, height: 4 });
  });

  it("builds none unless asked", async () => {
    expect((await decode({})).entry).toBeUndefined();
  });
});
