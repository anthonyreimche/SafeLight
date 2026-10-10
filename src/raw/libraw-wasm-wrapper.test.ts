// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The vendored libraw-wasm wrapper (src/raw/vendor/libraw-wasm/index.js, see
// PATCHES.md there) settles every call its worker answers. Its worker is faked:
// each reply is handed to the wrapper the way a browser dispatches a message,
// where an exception in the handler goes nowhere near the sender.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeWorker {
  static last: FakeWorker | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  /** Exceptions the wrapper's message handler threw. */
  readonly uncaught: unknown[] = [];

  constructor() {
    FakeWorker.last = this;
  }

  postMessage(): void {}

  reply(data: unknown): void {
    try {
      this.onmessage?.({ data });
    } catch (e) {
      this.uncaught.push(e);
    }
  }
}

/** Resolve after every already-queued microtask chain has run to completion. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

type Outcome = { value: unknown } | { error: unknown } | "pending";

async function outcomeOf(call: Promise<unknown>): Promise<Outcome> {
  let outcome: Outcome = "pending";
  call.then(
    (value) => (outcome = { value }),
    (error: unknown) => (outcome = { error }),
  );
  await settle();
  return outcome;
}

async function wrapper() {
  vi.resetModules();
  const { default: LibRaw } = await import("./vendor/libraw-wasm/index.js");
  const lib = new LibRaw();
  const worker = FakeWorker.last;
  if (!worker) throw new Error("the wrapper made no worker");
  return { lib, worker };
}

beforeEach(() => {
  FakeWorker.last = null;
  vi.stubGlobal("Worker", FakeWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the vendored libraw-wasm wrapper", () => {
  it("rejects a call its worker failed with a message", async () => {
    const { lib, worker } = await wrapper();
    const opening = lib.open(new Uint8Array(4));

    worker.reply({ error: "RuntimeError: unreachable" });

    expect(await outcomeOf(opening)).toEqual({ error: "RuntimeError: unreachable" });
    expect(worker.uncaught).toEqual([]);
  });

  it("resolves a call its worker answered", async () => {
    const { lib, worker } = await wrapper();
    const reading = lib.imageData();

    worker.reply({ out: { width: 2, height: 2 } });

    expect(await outcomeOf(reading)).toEqual({ value: { width: 2, height: 2 } });
  });

  // LibRaw's own C++ errors reach JS without a message; the adapter reads the
  // empty answer that results as "no image".
  it("still resolves undefined for a failure that carries no message", async () => {
    const { lib, worker } = await wrapper();
    const reading = lib.imageData();

    worker.reply({ error: undefined });

    expect(await outcomeOf(reading)).toEqual({ value: undefined });
  });
});
