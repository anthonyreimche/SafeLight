// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Background work (the "Cache all" pre-decode, Develop's neighbour prefetch,
// edited-thumbnail regeneration) never holds every libraw instance, so the
// photo the user opens starts decoding at once instead of waiting for a
// background decode to finish. libraw itself is faked: an instance here is
// only a token handed round.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("libraw-wasm", () => ({ default: class {} }));

import {
  acquireInstance,
  decodePoolSize,
  disposeDecodePool,
  releaseInstance,
  warmDecodePool,
} from "./decode-pool";

type Instance = NonNullable<Awaited<ReturnType<typeof acquireInstance>>>;

/** Resolve after every already-queued microtask chain has run to completion. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface Tracked {
  label: string;
  instance: Instance | null;
}

/** Asks for an instance and records, in `served`, when it arrives. */
function request(
  served: Tracked[],
  label: string,
  background: boolean,
): void {
  void acquireInstance({ background }).then((instance) => {
    served.push({ label, instance });
  });
}

beforeEach(() => {
  // Each instance owns a Worker over shared memory; Node has the latter only.
  vi.stubGlobal("Worker", class {});
  disposeDecodePool();
});

afterEach(() => {
  disposeDecodePool();
  vi.unstubAllGlobals();
});

describe("acquireInstance under a background pass", () => {
  it("keeps one instance free for the photo being opened", async () => {
    await warmDecodePool();
    const served: Tracked[] = [];
    for (let i = 0; i < decodePoolSize(); i++) request(served, `prefetch ${i}`, true);
    await settle();

    request(served, "opened", false);
    await settle();

    expect(served.map((s) => s.label)).toContain("opened");
  });

  it("lets background work hold every instance but one", async () => {
    await warmDecodePool();
    const served: Tracked[] = [];
    for (let i = 0; i < decodePoolSize(); i++) request(served, `prefetch ${i}`, true);
    await settle();

    expect(served).toHaveLength(decodePoolSize() - 1);
  });

  it("starts the held-back background decode once a background one finishes", async () => {
    await warmDecodePool();
    const served: Tracked[] = [];
    for (let i = 0; i < decodePoolSize(); i++) request(served, `prefetch ${i}`, true);
    await settle();
    expect(served).toHaveLength(2);

    const first = served[0].instance;
    if (!first) throw new Error("pool unavailable");
    releaseInstance(first);
    await settle();

    expect(served.map((s) => s.label)).toEqual(["prefetch 0", "prefetch 1", "prefetch 2"]);
  });

  it("does not hand the reserved instance to background work when an opened photo returns it", async () => {
    await warmDecodePool();
    const served: Tracked[] = [];
    request(served, "opened", false);
    for (let i = 0; i < decodePoolSize(); i++) request(served, `prefetch ${i}`, true);
    await settle();
    expect(served.map((s) => s.label)).toEqual(["opened", "prefetch 0", "prefetch 1"]);

    const opened = served[0].instance;
    if (!opened) throw new Error("pool unavailable");
    releaseInstance(opened);
    await settle();

    expect(served).toHaveLength(3);
    request(served, "next opened", false);
    await settle();
    expect(served.map((s) => s.label)).toEqual([
      "opened", "prefetch 0", "prefetch 1", "next opened",
    ]);
  });
});
