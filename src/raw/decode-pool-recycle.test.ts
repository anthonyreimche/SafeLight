// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// WASM memory only grows, so an instance that decoded a big frame keeps its heap
// for good. The pool ends such an instance once it has sat idle, and puts a fresh
// one in its place, so a decode that follows soon after still finds it warm.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  made: 0,
  ended: [] as unknown[],
}));

vi.mock("libraw-wasm", () => ({
  default: class {
    worker = { terminate: () => void h.ended.push(this) };
    constructor() {
      h.made++;
    }
  },
}));

import {
  acquireInstance,
  disposeDecodePool,
  releaseInstance,
  warmDecodePool,
} from "./decode-pool";

const BIG = 900_000_000;
const SMALL = 100_000_000;
const IDLE_MS = 30_000;

type Instance = NonNullable<Awaited<ReturnType<typeof acquireInstance>>>;

async function take(): Promise<Instance> {
  const inst = await acquireInstance();
  if (!inst) throw new Error("pool unavailable");
  return inst;
}

beforeEach(() => {
  h.made = 0;
  h.ended = [];
  vi.stubGlobal("Worker", class {});
  vi.useFakeTimers();
  disposeDecodePool();
});

afterEach(() => {
  disposeDecodePool();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("recycling an instance that decoded a big frame", () => {
  it("ends it after the pool has been idle, and refills the pool", async () => {
    await warmDecodePool();
    const big = await take();
    releaseInstance(big, BIG);

    await vi.advanceTimersByTimeAsync(IDLE_MS);

    expect(h.ended).toEqual([big]);
    expect(h.made).toBe(4);
    const next = [await take(), await take(), await take()];
    expect(next).not.toContain(big);
    expect(h.made).toBe(4);
  });

  it("waits while another instance is still held", async () => {
    await warmDecodePool();
    const big = await take();
    const other = await take();
    releaseInstance(big, BIG);

    await vi.advanceTimersByTimeAsync(IDLE_MS * 2);
    expect(h.ended).toEqual([]);

    releaseInstance(other);
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(h.ended).toEqual([big]);
  });

  it("does not recycle when a decode arrives before the timer", async () => {
    await warmDecodePool();
    const big = await take();
    releaseInstance(big, BIG);

    await vi.advanceTimersByTimeAsync(IDLE_MS - 1_000);
    const again = await take();
    await vi.advanceTimersByTimeAsync(IDLE_MS * 2);
    expect(h.ended).toEqual([]);

    releaseInstance(again, SMALL);
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(h.ended).toEqual([again]);
  });

  it("never recycles small decodes", async () => {
    await warmDecodePool();
    const small = await take();
    releaseInstance(small, SMALL);
    releaseInstance(await take());

    await vi.advanceTimersByTimeAsync(IDLE_MS * 4);

    expect(h.ended).toEqual([]);
    expect(h.made).toBe(3);
  });
});
