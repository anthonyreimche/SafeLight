// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A libraw instance whose call failed or hung is discarded, not handed back: a
// trap leaves its module unusable and a hung worker never answers. The pool
// ends its worker and puts a fresh instance in its place when one is needed,
// so it keeps its size and nobody waiting for an instance is stranded. libraw
// itself is faked: an instance is a token that knows whether it was ended.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  /** How many instances were made. */
  made: 0,
  /** Every instance whose worker was ended, in order. */
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
  decodePoolSize,
  discardInstance,
  disposeDecodePool,
  releaseInstance,
  warmDecodePool,
} from "./decode-pool";

type Instance = NonNullable<Awaited<ReturnType<typeof acquireInstance>>>;

/** Resolve after every already-queued microtask chain has run to completion. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function take(background = false): Promise<Instance> {
  const inst = await acquireInstance({ background });
  if (!inst) throw new Error("pool unavailable");
  return inst;
}

/** Records, in `served`, each request as it is answered. */
function wait(
  served: { label: string; inst: Instance | null }[],
  label: string,
  request: { background?: boolean; signal?: AbortSignal } = {},
): void {
  void acquireInstance(request).then((inst) => served.push({ label, inst }));
}

/** The pool held as a background pass holds it: two background, one opened. */
async function holdLikeAPass(): Promise<{ bg1: Instance; bg2: Instance; opened: Instance }> {
  await warmDecodePool();
  return { bg1: await take(true), bg2: await take(true), opened: await take() };
}

beforeEach(() => {
  h.made = 0;
  h.ended = [];
  // Each instance owns a Worker over shared memory; Node has the latter only.
  vi.stubGlobal("Worker", class {});
  disposeDecodePool();
});

afterEach(() => {
  disposeDecodePool();
  vi.unstubAllGlobals();
});

describe("acquireInstance on a cold pool", () => {
  it("warms a pool nobody warmed and hands out one of its instances", async () => {
    const inst = await acquireInstance();

    expect(inst).not.toBeNull();
    expect(decodePoolSize()).toBe(3);
    expect(h.made).toBe(3);
  });

  it("answers null where no instance can be made", async () => {
    vi.stubGlobal("Worker", undefined);

    expect(await acquireInstance()).toBeNull();
    expect(decodePoolSize()).toBe(0);
  });
});

describe("discardInstance", () => {
  it("ends the instance's worker and keeps the pool at its size", async () => {
    await warmDecodePool();
    const broken = await take();

    discardInstance(broken);

    expect(h.ended).toEqual([broken]);
    expect(decodePoolSize()).toBe(3);
    const all = [await take(), await take(), await take()];
    expect(new Set(all).size).toBe(3);
    expect(all).not.toContain(broken);
  });

  // A hung Develop decode and two hung background ones can all time out with
  // nobody waiting; the next decode must still find an instance.
  it("still serves a request after every instance was discarded with nobody waiting", async () => {
    await warmDecodePool();
    const all = [await take(), await take(), await take()];
    for (const inst of all) discardInstance(inst);

    const next = await acquireInstance();

    expect(next).not.toBeNull();
    expect(all).not.toContain(next);
    expect(decodePoolSize()).toBe(3);
  });

  it("makes the replacement only once one is needed", async () => {
    await warmDecodePool();
    discardInstance(await take());
    expect(h.made).toBe(3);

    await take();
    await take();
    await take();

    expect(h.made).toBe(4);
  });

  it("never hands a discarded instance out again, even when it is released", async () => {
    await warmDecodePool();
    const broken = await take();

    discardInstance(broken);
    releaseInstance(broken);

    expect([await take(), await take(), await take()]).not.toContain(broken);
  });

  it("serves the photo waiting behind the discarded instance with a fresh one", async () => {
    const { opened } = await holdLikeAPass();
    const served: { label: string; inst: Instance | null }[] = [];
    wait(served, "next photo");
    await settle();

    discardInstance(opened);
    await settle();

    expect(served).toHaveLength(1);
    expect(served[0].inst).not.toBe(opened);
    expect(h.ended).toEqual([opened]);
  });

  it("serves background work waiting behind a discarded background instance", async () => {
    const { bg1 } = await holdLikeAPass();
    const served: { label: string; inst: Instance | null }[] = [];
    wait(served, "prefetch", { background: true });
    await settle();

    discardInstance(bg1);
    await settle();

    expect(served.map((s) => s.label)).toEqual(["prefetch"]);
    expect(served[0].inst).not.toBe(bg1);
  });

  it("serves the waiters in their usual order: opened photos first", async () => {
    const { bg1, bg2 } = await holdLikeAPass();
    const served: { label: string; inst: Instance | null }[] = [];
    wait(served, "prefetch", { background: true });
    wait(served, "opened");
    await settle();

    discardInstance(bg1);
    await settle();
    expect(served.map((s) => s.label)).toEqual(["opened"]);

    discardInstance(bg2);
    await settle();
    expect(served.map((s) => s.label)).toEqual(["opened", "prefetch"]);
  });

  it("keeps the last instance for an opened photo when background work is at its cap", async () => {
    const { opened } = await holdLikeAPass();
    const served: { label: string; inst: Instance | null }[] = [];
    wait(served, "prefetch", { background: true });
    await settle();

    discardInstance(opened);
    await settle();
    expect(served).toEqual([]);

    const next = await take();
    expect(next).not.toBe(opened);
  });

  it("passes over a waiter that was abandoned", async () => {
    const { opened } = await holdLikeAPass();
    const served: { label: string; inst: Instance | null }[] = [];
    const left = new AbortController();
    wait(served, "left", { signal: left.signal });
    wait(served, "current");
    await settle();

    left.abort();
    discardInstance(opened);
    await settle();

    expect(served.map((s) => [s.label, s.inst !== null])).toEqual([
      ["left", false],
      ["current", true],
    ]);
  });
});
