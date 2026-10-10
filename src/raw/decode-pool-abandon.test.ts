// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A photo the user has already moved on from gives up its place in the queue
// for a libraw instance, so the photo they are on now is decoded first. Once an
// instance is handed out its decode runs to the end. libraw itself is faked: an
// instance here is only a token handed round.

import { describe, expect, it, vi } from "vitest";

vi.mock("libraw-wasm", () => ({ default: class {} }));

import {
  acquireInstance,
  decodePoolSize,
  releaseInstance,
  warmDecodePool,
} from "./decode-pool";
import {
  exhaustPool,
  freshPoolForEachTest,
  settle,
  type Instance,
} from "./decode-pool.test-support";

freshPoolForEachTest();

describe("acquireInstance for a request the user abandoned", () => {
  it("drops a waiter whose open was abandoned and serves the photo opened after it", async () => {
    const held = await exhaustPool();
    const order: string[] = [];
    const b = new AbortController();

    void acquireInstance({ signal: b.signal }).then((inst) =>
      order.push(inst ? "B" : "B dropped"),
    );
    void acquireInstance().then((inst) => order.push(inst ? "C" : "C dropped"));
    await settle();

    b.abort();
    releaseInstance(held[0]);
    await settle();

    expect(order).toEqual(["B dropped", "C"]);
  });

  it("drops an abandoned background waiter too", async () => {
    const held = await exhaustPool();
    const order: string[] = [];
    const prefetch = new AbortController();

    void acquireInstance({ background: true, signal: prefetch.signal }).then((inst) =>
      order.push(inst ? "prefetch" : "prefetch dropped"),
    );
    void acquireInstance({ background: true }).then((inst) =>
      order.push(inst ? "next prefetch" : "next prefetch dropped"),
    );
    await settle();

    prefetch.abort();
    releaseInstance(held[0]);
    await settle();

    expect(order).toEqual(["prefetch dropped", "next prefetch"]);
  });

  it("answers a request abandoned before it asked with no instance, and keeps the instance free", async () => {
    await warmDecodePool();
    const gone = new AbortController();
    gone.abort();

    await expect(acquireInstance({ signal: gone.signal })).resolves.toBeNull();

    const held = await exhaustPool();
    expect(new Set(held).size).toBe(decodePoolSize());
  });

  it("leaves a decode that already has its instance running when its request is abandoned", async () => {
    await warmDecodePool();
    const opened = new AbortController();
    const running = await acquireInstance({ signal: opened.signal });
    if (!running) throw new Error("pool unavailable");
    const others: Instance[] = [];
    for (let i = 1; i < decodePoolSize(); i++) {
      const inst = await acquireInstance();
      if (!inst) throw new Error("pool unavailable");
      others.push(inst);
    }

    opened.abort();
    let next: Instance | null = null;
    void acquireInstance().then((inst) => {
      next = inst;
    });
    await settle();
    expect(next).toBeNull();

    releaseInstance(running);
    await settle();
    expect(next).toBe(running);
  });
});
