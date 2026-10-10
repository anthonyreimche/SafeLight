// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The cache worker keeps a negative marker (a small entry holding a short text)
// where it keeps previews, under the same project rules. And a write or a clear
// acts on the project it was sent for, even when the folder changes meanwhile.

import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryFs, fsaDirectoryHandle } from "@/project/memory-fs.test-support";
import type { CacheRequest } from "./cache-worker";
import { FakeIndexedDB, startCacheWorker } from "./cache-worker.test-support";

afterEach(() => {
  vi.unstubAllGlobals();
});

const KEY = "v6:DSC00001.ARW:52428800:0";
const MARKER = `unsupported@libraw#1:${KEY}`;
const A = "/A/.safelight/raw";
const B = "/B/.safelight/raw";

const inFolder = (fs: MemoryFs, dir: string): CacheRequest => ({
  cmd: "setCacheDir", dir: fsaDirectoryHandle(fs, dir), scope: "",
});
const scopeTo = (scope: string): CacheRequest => ({ cmd: "setCacheDir", dir: null, scope });
const fileOf = (dir: string, key: string) => `${dir}/${encodeURIComponent(key)}.bin`;

describe("cache worker, while the project changes", () => {
  it("lands a write in its own project's folder if the folder changes mid-compress", async () => {
    const fs = new MemoryFs(A, B);
    const { post, send } = await startCacheWorker();
    await send(inFolder(fs, A));
    const data = new Float32Array(2 * 2 * 4).fill(0.5);

    const writing = post({ cmd: "write", id: 1, key: KEY, data, width: 2, height: 2, maxEdge: 64 });
    await post(inFolder(fs, B));
    await writing;

    expect(fs.has(fileOf(A, KEY))).toBe(true);
    expect(fs.has(fileOf(B, KEY))).toBe(false);
  });

  it("clears the folder it was asked to when the folder changes as it clears", async () => {
    const fs = new MemoryFs(A, B)
      .put(`${A}/x.bin`, "x").put(`${A}/y.bin`, "y")
      .put(`${B}/x.bin`, "x").put(`${B}/y.bin`, "y");
    const { post, send } = await startCacheWorker();
    await send(inFolder(fs, A));

    const clearing = post({ cmd: "clear", id: 1 });
    await post(inFolder(fs, B));
    await clearing;

    expect([fs.has(`${A}/x.bin`), fs.has(`${A}/y.bin`)]).toEqual([false, false]);
    expect([fs.has(`${B}/x.bin`), fs.has(`${B}/y.bin`)]).toEqual([true, true]);
  });
});

describe("cache worker, markers in the project folder", () => {
  it("stores a marker's text, lists it, reads it back, and forgets it once deleted", async () => {
    const fs = new MemoryFs(A);
    const { send } = await startCacheWorker();
    await send(inFolder(fs, A));

    expect(await send({ cmd: "mark", id: 1, key: MARKER, value: "s1" })).toEqual({
      type: "mark", id: 1,
    });
    expect(await send({ cmd: "keys", id: 2 })).toEqual({ type: "keys", id: 2, keys: [MARKER] });
    expect(await send({ cmd: "peek", id: 3, key: MARKER })).toEqual({
      type: "peek", id: 3, value: "s1",
    });

    await send({ cmd: "delete", id: 4, key: MARKER });

    expect(await send({ cmd: "peek", id: 5, key: MARKER })).toEqual({
      type: "peek", id: 5, value: null,
    });
    expect(fs.has(fileOf(A, MARKER))).toBe(false);
  });

  // A folder marker is created empty and gets its text when its file closes;
  // until then it is no marker at all.
  it("reads a marker whose text hasn't landed yet as no marker", async () => {
    const fs = new MemoryFs(A).put(fileOf(A, MARKER), "");
    const { send } = await startCacheWorker();
    await send(inFolder(fs, A));

    expect(await send({ cmd: "peek", id: 1, key: MARKER })).toEqual({
      type: "peek", id: 1, value: null,
    });
  });

  it("clears markers with the previews", async () => {
    const fs = new MemoryFs(A);
    const { send } = await startCacheWorker();
    await send(inFolder(fs, A));
    await send({ cmd: "mark", id: 1, key: MARKER, value: "s1" });

    await send({ cmd: "clear", id: 2 });

    expect(await send({ cmd: "keys", id: 3 })).toEqual({ type: "keys", id: 3, keys: [] });
  });
});

describe("cache worker, markers in the shared database", () => {
  it("keeps a marker to the project it was stored for", async () => {
    const { send } = await startCacheWorker(new FakeIndexedDB());
    await send(scopeTo("D:/A"));
    await send({ cmd: "mark", id: 1, key: MARKER, value: "s1" });

    await send(scopeTo("D:/B"));
    expect(await send({ cmd: "peek", id: 2, key: MARKER })).toMatchObject({ value: null });
    expect(await send({ cmd: "keys", id: 3 })).toMatchObject({ keys: [] });

    await send(scopeTo("D:/A"));
    expect(await send({ cmd: "peek", id: 4, key: MARKER })).toMatchObject({ value: "s1" });
    expect(await send({ cmd: "keys", id: 5 })).toMatchObject({ keys: [MARKER] });
  });

  it("clears markers with the previews", async () => {
    const idb = new FakeIndexedDB();
    const { send } = await startCacheWorker(idb);
    await send(scopeTo("D:/A"));
    await send({ cmd: "mark", id: 1, key: MARKER, value: "s1" });

    await send({ cmd: "clear", id: 2 });

    expect(idb.rows.size).toBe(0);
  });
});
