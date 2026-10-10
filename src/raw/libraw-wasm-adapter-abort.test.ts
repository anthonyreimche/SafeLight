// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A libraw decode the user abandoned while it waited for an instance is not a
// failure: it opens nothing. The pool is faked; decode-pool-abandon.test.ts
// pins how it drops an abandoned request.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  /** Each request handed to the pool, in order. */
  requests: [] as ({ background?: boolean; signal?: AbortSignal } | undefined)[],
  /** Whether the pool has any instance to hand out at all. */
  available: true,
  opened: 0,
}));

vi.mock("./decode-pool", () => {
  const instance = {
    async open() {
      h.opened++;
    },
    async metadata() {
      return { width: 2, height: 2, color_data: { cam_mul: [1, 1, 1, 1] } };
    },
    async imageData() {
      return new Uint16Array(2 * 2 * 3).fill(12000);
    },
  };
  return {
    acquireInstance: async (request?: { background?: boolean; signal?: AbortSignal }) => {
      h.requests.push(request);
      return h.available && !request?.signal?.aborted ? instance : null;
    },
    releaseInstance: () => {},
  };
});

import { decodeRawFloatViaLibRaw, extractRawMetadata } from "./libraw-wasm-adapter";

const rawBytes = (): ArrayBuffer => new ArrayBuffer(2 * 1024 * 1024);

beforeEach(() => {
  h.requests = [];
  h.available = true;
  h.opened = 0;
  // libraw runs in a Worker on shared memory; Node has the latter, not the former.
  vi.stubGlobal("Worker", class {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("decodeRawFloatViaLibRaw for a request the user abandoned", () => {
  it("hands the request's signal to the pool along with its priority", async () => {
    const opened = new AbortController();

    await decodeRawFloatViaLibRaw(rawBytes(), { background: true, signal: opened.signal });

    expect(h.requests).toEqual([{ background: true, signal: opened.signal }]);
  });

  it("opens nothing", async () => {
    await decodeRawFloatViaLibRaw(rawBytes());
    const gone = new AbortController();
    gone.abort();

    const image = await decodeRawFloatViaLibRaw(rawBytes(), { signal: gone.signal });

    expect(image).toEqual({ failure: "aborted" });
    expect(h.opened).toBe(1);
  });

  it("still reports a pool with no instances when nothing was abandoned", async () => {
    h.available = false;

    const image = await decodeRawFloatViaLibRaw(rawBytes(), {
      signal: new AbortController().signal,
    });

    expect(image).toEqual({ failure: "transient", reason: "decode pool unavailable" });
  });
});

// The repair and rebuild passes read each RAW's frame size this way; a photo
// opened meanwhile goes ahead of them.
describe("extractRawMetadata", () => {
  it("hands its request to the pool", async () => {
    const project = new AbortController();

    await extractRawMetadata(rawBytes(), { background: true, signal: project.signal });

    expect(h.requests).toEqual([{ background: true, signal: project.signal }]);
  });

  it("opens nothing for a request abandoned before it began", async () => {
    const gone = new AbortController();
    gone.abort();

    const meta = await extractRawMetadata(rawBytes(), { signal: gone.signal });

    expect(meta).toBeUndefined();
    expect(h.opened).toBe(0);
  });
});
