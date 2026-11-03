// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A failed load of libraw-wasm must not strand every RAW for the session: the
// next request loads it again, and the first failure's message stays readable.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ loads: 0 }));

vi.mock("libraw-wasm", () => ({
  get default() {
    h.loads++;
    if (h.loads === 1) throw new Error("chunk load failed");
    return class {};
  },
}));

import {
  acquireInstance,
  decodePoolFailure,
  disposeDecodePool,
} from "./decode-pool";

beforeEach(() => {
  vi.stubGlobal("Worker", class {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  disposeDecodePool();
});

afterEach(() => {
  disposeDecodePool();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("decode pool after a failed libraw-wasm load", () => {
  it("keeps the failure's message, then recovers on the next request", async () => {
    expect(await acquireInstance()).toBeNull();
    expect(decodePoolFailure()).toContain("chunk load failed");

    expect(await acquireInstance()).not.toBeNull();
    expect(decodePoolFailure()).toBeUndefined();
  });
});
