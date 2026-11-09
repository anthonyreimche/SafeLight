// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Making a libraw instance can fail (the Worker is refused, memory runs out).
// The pool then keeps whatever it did make, and a request it can't serve gets
// null, never a throw: callers read null as "libraw is unavailable".

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  /** The index of the first instance whose construction throws. */
  failFrom: Infinity,
  /** How many instances were asked for, made or not. */
  made: 0,
}));

vi.mock("libraw-wasm", () => ({
  default: class {
    worker = { terminate: () => {} };
    constructor() {
      if (h.made++ >= h.failFrom) throw new Error("no worker");
    }
  },
}));

import {
  acquireInstance,
  decodePoolFailure,
  decodePoolSize,
  discardInstance,
  warmDecodePool,
} from "./decode-pool";
import { exhaustPool, freshPoolForEachTest, settle } from "./decode-pool.test-support";

freshPoolForEachTest();

beforeEach(() => {
  h.failFrom = Infinity;
  h.made = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("decode pool when an instance can't be made", () => {
  it("resolves null, with the reason, when no instance can be made", async () => {
    h.failFrom = 0;

    await expect(warmDecodePool()).resolves.toBeUndefined();
    await expect(acquireInstance()).resolves.toBeNull();
    expect(decodePoolFailure()).toContain("no worker");
  });

  it("keeps the instances it made before one failed", async () => {
    h.failFrom = 1;

    await warmDecodePool();

    expect(decodePoolSize()).toBe(1);
    await expect(acquireInstance()).resolves.not.toBeNull();
  });

  it("discards without throwing when no replacement can be made, and frees the waiters", async () => {
    h.failFrom = 3;
    const [a, b, c] = await exhaustPool();
    h.failFrom = 0;

    expect(() => discardInstance(a)).not.toThrow();
    expect(() => discardInstance(b)).not.toThrow();
    const pending = acquireInstance();
    await settle();
    expect(() => discardInstance(c)).not.toThrow();

    await expect(pending).resolves.toBeNull();
  });
});
