// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The libraw pool with its instances as plain tokens. A test file using this
// fakes "libraw-wasm" itself, so the fake is in place before the pool loads it.

import { afterEach, beforeEach, vi } from "vitest";
import {
  acquireInstance,
  decodePoolSize,
  disposeDecodePool,
  warmDecodePool,
} from "./decode-pool";

export type Instance = NonNullable<Awaited<ReturnType<typeof acquireInstance>>>;

/** Resolve after every already-queued microtask chain has run to completion. */
export const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Takes every instance in the pool, so the next request has to wait. */
export async function exhaustPool(): Promise<Instance[]> {
  await warmDecodePool();
  const held: Instance[] = [];
  for (let i = 0; i < decodePoolSize(); i++) {
    const inst = await acquireInstance();
    if (!inst) throw new Error("pool unavailable");
    held.push(inst);
  }
  return held;
}

/** Starts each test of the calling file on an empty pool. */
export function freshPoolForEachTest(): void {
  beforeEach(() => {
    // Each instance owns a Worker over shared memory; Node has the latter only.
    vi.stubGlobal("Worker", class {});
    disposeDecodePool();
  });

  afterEach(() => {
    disposeDecodePool();
    vi.unstubAllGlobals();
  });
}
