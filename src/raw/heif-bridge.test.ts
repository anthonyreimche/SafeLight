// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Without a Worker (vitest's node) the bridge decodes inline with the real
// libheif; the pool itself is driven through a stand-in Worker.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { HeifReply, HeifRequest } from "./heif-decode";
import { HEIF_P3_10, HEIF_SRGB8, heifBlob } from "./heif-fixtures.test-support";
import type { HalfFrame } from "./profile-frame";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetModules();
});

describe("inline, with no Worker", () => {
  it("decodes a HEIF frame", async () => {
    const { decodeHeifFrame } = await import("./heif-bridge");
    const result = await decodeHeifFrame(heifBlob(HEIF_P3_10), { targetEdge: 32, turn: 90, background: false });
    if (!result.ok) throw new Error(result.reason);
    expect([result.frame.width, result.frame.height, result.sourceWidth, result.sourceHeight]).toEqual([24, 32, 64, 48]);
    expect(result.hdr).toBe(false);
  });

  it("answers a failure, not a rejection, for a file it can't decode", async () => {
    const { decodeHeifFrame } = await import("./heif-bridge");
    const result = await decodeHeifFrame(new Blob([new Uint8Array(32)]), { background: true });
    expect(result.ok).toBe(false);
  });

  it("answers aborted for a signal already fired", async () => {
    const { decodeHeifFrame } = await import("./heif-bridge");
    const controller = new AbortController();
    controller.abort();
    const result = await decodeHeifFrame(heifBlob(HEIF_P3_10), { background: false, signal: controller.signal });
    expect(result).toMatchObject({ ok: false, aborted: true });
  });

  it("makes the thumbnail's ImageBitmap where the thread can", async () => {
    const { decodeHeifThumb } = await import("./heif-bridge");
    const refused = await decodeHeifThumb(heifBlob(HEIF_SRGB8), { maxEdge: 32, background: true });
    expect(refused.ok).toBe(false);

    class FakeImageData {
      readonly width: number;
      readonly height: number;
      constructor(_data: Uint8ClampedArray, width: number, height: number) {
        this.width = width;
        this.height = height;
      }
    }
    vi.stubGlobal("ImageData", FakeImageData);
    vi.stubGlobal("createImageBitmap", (image: FakeImageData) =>
      Promise.resolve({ width: image.width, height: image.height, close() {} }),
    );
    const result = await decodeHeifThumb(heifBlob(HEIF_SRGB8), { maxEdge: 32, background: true });
    if (!result.ok) throw new Error(result.reason);
    expect([result.width, result.height, result.sourceWidth, result.sourceHeight]).toEqual([24, 32, 48, 64]);
    expect(result.bitmap.width).toBe(24);
  });

  it("converts an extension's linear frame", async () => {
    const { convertLinearFrame } = await import("./heif-bridge");
    const data = new Float32Array([0.5, 0.25, 1, 1, Number.NaN, 0, 0, 1]);
    const result = await convertLinearFrame(data, 2, 1, { turn: 90, background: false });
    if (!result.ok) throw new Error(result.reason);
    expect([result.frame.width, result.frame.height]).toEqual([1, 2]);
  });
});

class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((e: MessageEvent<HeifReply>) => void) | null = null;
  onerror: ((e: { message: string; preventDefault(): void }) => void) | null = null;
  posted: HeifRequest[] = [];
  terminated = false;

  constructor() {
    FakeWorker.all.push(this);
  }

  postMessage(request: HeifRequest): void {
    this.posted.push(request);
  }

  terminate(): void {
    this.terminated = true;
  }

  answerFrame(): void {
    const request = this.posted[this.posted.length - 1];
    const frame: HalfFrame = { data: new Uint16Array(4), width: 1, height: 1, fullWidth: 1, fullHeight: 1 };
    const reply: HeifReply = { id: request.id, op: "frame", frame, sourceWidth: 1, sourceHeight: 1, hdr: false };
    this.onmessage?.(new MessageEvent("message", { data: reply }));
  }
}

async function pool() {
  FakeWorker.all = [];
  vi.useFakeTimers();
  vi.stubGlobal("Worker", FakeWorker);
  return import("./heif-bridge");
}

const file = () => new Blob([new Uint8Array(16)]);

describe("the worker pool", () => {
  it("runs two jobs at once and keeps one worker for interactive work", async () => {
    const { decodeHeifFrame } = await pool();
    const first = decodeHeifFrame(file(), { background: true });
    void decodeHeifFrame(file(), { background: true });
    void decodeHeifFrame(file(), { background: false });
    expect(FakeWorker.all).toHaveLength(2);
    const [a, b] = FakeWorker.all;
    expect(a.posted).toHaveLength(1);
    expect(b.posted).toHaveLength(1);
    a.answerFrame();
    await expect(first).resolves.toMatchObject({ ok: true });
    expect(a.posted).toHaveLength(2);
    expect(FakeWorker.all).toHaveLength(2);
  });

  it("fails a job its worker never answers and ends that worker", async () => {
    const { decodeHeifFrame } = await pool();
    const job = decodeHeifFrame(file(), { background: false });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await expect(job).resolves.toMatchObject({ ok: false });
    expect(FakeWorker.all[0].terminated).toBe(true);
  });

  it("ends idle workers", async () => {
    const { decodeHeifFrame, IDLE_MS } = await pool();
    const job = decodeHeifFrame(file(), { background: false });
    FakeWorker.all[0].answerFrame();
    await job;
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
    expect(FakeWorker.all[0].terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWorker.all[0].terminated).toBe(true);
  });

  it("drops a waiting job whose signal fires, and lets a running one go", async () => {
    const { decodeHeifFrame } = await pool();
    const running = new AbortController();
    const waiting = new AbortController();
    const first = decodeHeifFrame(file(), { background: false, signal: running.signal });
    void decodeHeifFrame(file(), { background: false });
    const third = decodeHeifFrame(file(), { background: false, signal: waiting.signal });
    waiting.abort();
    await expect(third).resolves.toMatchObject({ ok: false, aborted: true });
    running.abort();
    await expect(first).resolves.toMatchObject({ ok: false, aborted: true });
    FakeWorker.all[0].answerFrame();
    expect(FakeWorker.all[0].posted).toHaveLength(1);
  });

  it("stops spawning workers that keep failing", async () => {
    const { decodeHeifFrame } = await pool();
    for (let i = 0; i < 3; i++) {
      const job = decodeHeifFrame(file(), { background: false });
      const worker = FakeWorker.all[FakeWorker.all.length - 1];
      worker.onerror?.({ message: "bundle failed", preventDefault() {} });
      await expect(job).resolves.toMatchObject({ ok: false });
    }
    const spawned = FakeWorker.all.length;
    await expect(decodeHeifFrame(file(), { background: false })).resolves.toMatchObject({ ok: false });
    expect(FakeWorker.all).toHaveLength(spawned);
  });
});
