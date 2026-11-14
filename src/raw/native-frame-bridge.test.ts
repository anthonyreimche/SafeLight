// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The native frame worker's client. The worker is faked by running the real
// handler on structured clones, so a buffer handed over is detached here as it
// is in a browser.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { halfBits } from "./half-float";
import type { NativeLuma } from "./native-frame";
import { NativeFrameHolder, type NativeFrameRequest } from "./native-frame-job";

class FakeWorker {
  static all: FakeWorker[] = [];
  /** Cuts sit unanswered until answerNext(). */
  static hold = false;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  readonly holder = new NativeFrameHolder();
  readonly queue: NativeFrameRequest[] = [];
  /** The op of every message posted, in order. */
  readonly ops: string[] = [];
  terminated = false;

  constructor() {
    FakeWorker.all.push(this);
  }

  postMessage(msg: NativeFrameRequest, transfer: Transferable[]): void {
    this.ops.push(msg.op);
    this.queue.push(structuredClone(msg, { transfer }));
    if (!FakeWorker.hold) this.answerAll();
  }

  answerAll(): void {
    while (this.queue.length > 0) this.answerNext();
  }

  answerNext(): void {
    const req = this.queue.shift();
    if (!req) throw new Error("nothing to answer");
    const answer = this.holder.handle(req);
    if (!answer) return;
    const data = structuredClone(answer.reply, { transfer: answer.transfer });
    setTimeout(() => this.onmessage?.({ data }));
  }

  terminate(): void {
    this.terminated = true;
  }
}

async function load() {
  vi.resetModules();
  return import("./native-frame-bridge");
}

function frame(width = 8, height = 6): NativeLuma {
  const data = new Uint16Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = halfBits(0.1 + ((i * 7) % 11) / 20);
  return { data, width, height };
}

const want = (key = "a") => ({ key, rect: { x: 0, y: 0, w: 1, h: 1 }, outW: 8, outH: 6, baseW: 4, baseH: 3 });

beforeEach(() => {
  FakeWorker.all = [];
  FakeWorker.hold = false;
  vi.stubGlobal("Worker", FakeWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the native frame worker's client", () => {
  it("makes one worker on the first hold, keeps it, and hands the frame over without a copy", async () => {
    const { holdNativeLuma } = await load();
    const first = frame();
    holdNativeLuma("a", first);
    holdNativeLuma("b", frame());
    expect(FakeWorker.all).toHaveLength(1);
    expect(first.data.buffer.byteLength).toBe(0);
  });

  it("cuts a gain from the frame held for the key, and none for another key", async () => {
    const { cutNativeGain, holdNativeLuma } = await load();
    holdNativeLuma("a", frame());
    const gain = await cutNativeGain(want());
    expect(gain?.width).toBe(8);
    expect(gain?.height).toBe(6);
    expect(await cutNativeGain(want("b"))).toBeNull();
  });

  it("drops the frame, or with a key only that photo's", async () => {
    const { cutNativeGain, dropNativeLuma, holdNativeLuma } = await load();
    holdNativeLuma("a", frame());
    dropNativeLuma("b");
    expect(await cutNativeGain(want())).not.toBeNull();
    dropNativeLuma("a");
    expect(await cutNativeGain(want())).toBeNull();
    holdNativeLuma("a", frame());
    dropNativeLuma();
    expect(await cutNativeGain(want())).toBeNull();
  });

  it("runs one cut at a time, and a newer request replaces the one waiting", async () => {
    const { cutNativeGain, holdNativeLuma } = await load();
    holdNativeLuma("a", frame());
    FakeWorker.hold = true;
    const running = cutNativeGain(want());
    const overtaken = cutNativeGain({ ...want(), outW: 4, outH: 3 });
    const newest = cutNativeGain({ ...want(), outW: 6, outH: 6 });
    const worker = FakeWorker.all[0];
    expect(worker.ops.filter((op) => op === "cut")).toHaveLength(1);
    expect(await overtaken).toBeNull();
    worker.answerNext();
    expect((await running)?.width).toBe(8);
    await new Promise((r) => setTimeout(r, 0));
    expect(worker.ops.filter((op) => op === "cut")).toHaveLength(2);
    worker.answerNext();
    expect((await newest)?.width).toBe(6);
  });

  it("answers null without a worker, and drops the frame it is handed", async () => {
    vi.stubGlobal("Worker", undefined);
    const { cutNativeGain, holdNativeLuma } = await load();
    const held = frame();
    holdNativeLuma("a", held);
    expect(await cutNativeGain(want())).toBeNull();
    expect(held.data.buffer.byteLength).toBeGreaterThan(0);
  });

  it("answers what waits with null when the worker fails, and the next hold makes another", async () => {
    const { cutNativeGain, holdNativeLuma } = await load();
    holdNativeLuma("a", frame());
    FakeWorker.hold = true;
    const running = cutNativeGain(want());
    const waiting = cutNativeGain(want());
    const failed = FakeWorker.all[0];
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    failed.onerror?.({ message: "crashed" });
    expect(await running).toBeNull();
    expect(await waiting).toBeNull();
    expect(failed.terminated).toBe(true);
    expect(await cutNativeGain(want())).toBeNull();

    FakeWorker.hold = false;
    holdNativeLuma("a", frame());
    expect(FakeWorker.all).toHaveLength(2);
    expect(await cutNativeGain(want())).not.toBeNull();
  });
});
