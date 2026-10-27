// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeFsBridge } from "@/extensions/types";
import { MemoryFs, fsaDirectoryHandle } from "@/project/memory-fs.test-support";
import type { CacheRequest, CacheResponse } from "./cache-worker";

const h = vi.hoisted(() => ({ fs: null as NativeFsBridge | null }));

vi.mock("@/native/privileged", () => ({ privilegedFs: () => h.fs }));

/** Handles the fake host can clone, as a browser clones real File System
 *  Access handles. Anything else throws DataCloneError, like Electron's
 *  path-backed handles do. */
const browserHandles = new WeakSet<FileSystemDirectoryHandle>();

class FakeWorker {
  static last: FakeWorker | null = null;
  onmessage: ((e: MessageEvent<CacheResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly delivered: CacheRequest[] = [];

  constructor() {
    FakeWorker.last = this;
    setTimeout(() =>
      this.onmessage?.(new MessageEvent("message", { data: { type: "ready" } })),
    );
  }

  postMessage(msg: CacheRequest): void {
    if (msg.cmd === "setCacheDir" && msg.dir && !browserHandles.has(msg.dir))
      throw new DOMException("The handle could not be cloned.", "DataCloneError");
    this.delivered.push(msg);
  }
}

// The bridge keeps its worker in module scope, and native-fs brands handles
// with a module-local symbol, so both load fresh, together, for each case.
async function load() {
  vi.resetModules();
  const nativeFs = await import("@/project/native-fs");
  const bridge = await import("./cache-bridge");
  return { ...nativeFs, ...bridge };
}

async function delivered(): Promise<CacheRequest[]> {
  await vi.waitFor(() => expect(FakeWorker.last?.delivered.length).toBeGreaterThan(0));
  return FakeWorker.last?.delivered ?? [];
}

/** The worker's reply to a message the bridge sent. */
function answer(reply: CacheResponse): void {
  FakeWorker.last?.onmessage?.(new MessageEvent("message", { data: reply }));
}

beforeEach(() => {
  FakeWorker.last = null;
  h.fs = null;
  vi.stubGlobal("Worker", FakeWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("setCacheDirOnWorker", () => {
  it("scopes the shared cache to the folder's path when its handle can't be cloned", async () => {
    h.fs = new MemoryFs("D:/A/.safelight/raw");
    const { nativeDirectoryHandle, setCacheDirOnWorker } = await load();

    setCacheDirOnWorker(nativeDirectoryHandle("D:/A/.safelight/raw"));

    expect(await delivered()).toEqual([
      { cmd: "setCacheDir", dir: null, scope: "D:/A/.safelight/raw" },
    ]);
  });

  // Every project's cache folder is named "raw", so the name can't tell two
  // projects apart: with no path, the worker must cache nothing at all.
  it("turns the cache off when an uncloneable handle has no path to scope by", async () => {
    const { setCacheDirOnWorker } = await load();
    const dir = fsaDirectoryHandle(new MemoryFs("/p/.safelight/raw"), "/p/.safelight/raw");

    setCacheDirOnWorker(dir);

    expect(await delivered()).toEqual([{ cmd: "setCacheDir", dir: null, scope: null }]);
  });

  it("hands a cloneable folder straight to the worker", async () => {
    const { setCacheDirOnWorker } = await load();
    const dir = fsaDirectoryHandle(new MemoryFs("/p/.safelight/raw"), "/p/.safelight/raw");
    browserHandles.add(dir);

    setCacheDirOnWorker(dir);

    expect(await delivered()).toEqual([{ cmd: "setCacheDir", dir, scope: "" }]);
  });

  it("uses the no-project scope when no folder is open", async () => {
    const { setCacheDirOnWorker } = await load();

    setCacheDirOnWorker(null);

    expect(await delivered()).toEqual([{ cmd: "setCacheDir", dir: null, scope: "" }]);
  });
});

describe("workerReadCachedPreview", () => {
  it("asks for the sample only when told to, and hands the entry back whole", async () => {
    const { workerReadCachedPreview } = await load();
    const reading = workerReadCachedPreview("k", true);
    const [msg] = await delivered();
    expect(msg).toEqual({ cmd: "read", id: expect.any(Number), key: "k", sample: true });
    if (msg.cmd !== "read") throw new Error("not a read");
    const sample = { data: new Uint16Array(4), width: 1, height: 1, x: 2, y: 3, sourceWidth: 6, sourceHeight: 4 };
    answer({ type: "read", id: msg.id, data: new Uint16Array(8), width: 2, height: 1, full: { width: 6, height: 4 }, sample });
    expect(await reading).toEqual({ data: new Uint16Array(8), width: 2, height: 1, full: { width: 6, height: 4 }, sample });
  });

  it("is null for a miss", async () => {
    const { workerReadCachedPreview } = await load();
    const reading = workerReadCachedPreview("k", false);
    const [msg] = await delivered();
    if (msg.cmd !== "read") throw new Error("not a read");
    expect(msg.sample).toBe(false);
    answer({ type: "read", id: msg.id, data: null, width: 0, height: 0, full: null, sample: null });
    expect(await reading).toBeNull();
  });
});

describe("workerCachedKeys", () => {
  it("hands back each entry with whether it is complete", async () => {
    const { workerCachedKeys } = await load();
    const listing = workerCachedKeys();
    const [msg] = await delivered();
    if (msg.cmd !== "keys") throw new Error("not a listing");
    answer({ type: "keys", id: msg.id, entries: [{ key: "a", complete: true }, { key: "b", complete: false }] });
    expect(await listing).toEqual([{ key: "a", complete: true }, { key: "b", complete: false }]);
  });
});
