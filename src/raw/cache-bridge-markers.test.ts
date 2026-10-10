// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The bridge's marker requests: what reaches the worker, and how its reply (or
// its error) comes back. The worker is a fake that answers like the real one.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CacheRequest, CacheResponse } from "./cache-worker";

const h = vi.hoisted(() => ({
  /** What the fake worker holds: each marker key and its text. */
  markers: new Map<string, string>(),
  /** Every request that reached the worker. */
  delivered: [] as unknown[],
  /** Whether the worker answers each request with an error. */
  failing: false,
}));

class FakeWorker {
  onmessage: ((e: MessageEvent<CacheResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;

  constructor() {
    setTimeout(() => this.answer({ type: "ready" }));
  }

  postMessage(msg: CacheRequest): void {
    h.delivered.push(msg);
    if (!("id" in msg)) return;
    if (h.failing) return this.answer({ type: "error", id: msg.id, message: "disk full" });
    if (msg.cmd === "mark") {
      h.markers.set(msg.key, msg.value);
      this.answer({ type: "mark", id: msg.id });
    } else if (msg.cmd === "peek") {
      this.answer({ type: "peek", id: msg.id, value: h.markers.get(msg.key) ?? null });
    }
  }

  private answer(reply: CacheResponse): void {
    queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data: reply })));
  }
}

async function load() {
  vi.resetModules();
  return import("./cache-bridge");
}

beforeEach(() => {
  h.markers = new Map();
  h.delivered = [];
  h.failing = false;
  vi.stubGlobal("Worker", FakeWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("workerWriteMarker", () => {
  it("hands the worker the key and its text, and settles on the reply", async () => {
    const { workerWriteMarker } = await load();

    const key = "unsupported#1:v6:a.ARW:8:0";

    await workerWriteMarker(key, "session-1");

    expect(h.delivered).toEqual([
      expect.objectContaining({ cmd: "mark", key, value: "session-1" }),
    ]);
  });

  it("fails when the worker reports an error", async () => {
    h.failing = true;
    const { workerWriteMarker } = await load();

    await expect(workerWriteMarker("k", "s")).rejects.toThrow("disk full");
  });
});

describe("workerReadMarker", () => {
  it("answers the marker's text, or null for a key the worker doesn't hold", async () => {
    const { workerReadMarker, workerWriteMarker } = await load();
    await workerWriteMarker("k", "session-1");

    expect(await workerReadMarker("k")).toBe("session-1");
    expect(await workerReadMarker("other")).toBeNull();
    expect(h.delivered.at(-1)).toEqual(expect.objectContaining({ cmd: "peek", key: "other" }));
  });
});
