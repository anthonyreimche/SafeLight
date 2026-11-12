// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// How much of a kept original the desktop reads: asking whether it is kept reads
// none of it, and a slice (the export's EXIF harvest, the import's head read)
// reads only that slice, not the whole RAW over the bridge.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeFsBridge } from "@/extensions/types";

const h = vi.hoisted(() => ({ fs: null as NativeFsBridge | null }));

vi.mock("@/native/privileged", () => ({ privilegedFs: () => h.fs }));

import {
  bindSourceCache,
  dropLibrarySources,
  readSourceFileSlice,
  registerLibrarySource,
  sourceOriginalHeld,
  sourceRoot,
} from "./library-sources";
import { MemoryFs } from "./memory-fs.test-support";
import { nativeDirectoryHandle } from "./native-fs";

const SIZE = 50_000;

let mem: MemoryFs;

beforeEach(() => {
  mem = new MemoryFs("/sl");
  h.fs = mem;
  registerLibrarySource("ext.a", {
    id: "test.server",
    name: "Server",
    list: async () => ({ items: [{ key: "k", name: "a.NEF", size: SIZE }] }),
    readPreview: async () => new Blob(),
    readOriginal: async () => new Blob([new Uint8Array(SIZE)]),
  });
});

afterEach(() => dropLibrarySources("ext.a"));

async function keptHandle() {
  const root = sourceRoot("test.server")!;
  bindSourceCache(root, nativeDirectoryHandle("/sl"));
  const handle = await root.getFileHandle("a.NEF");
  await handle.getFile();
  const [path] = mem.tree("/sl/originals");
  return { handle, read: () => mem.bytesRead(path) };
}

describe("a kept original on the desktop", () => {
  it("is known to be kept without reading it", async () => {
    const { handle, read } = await keptHandle();
    const before = read();
    expect(await sourceOriginalHeld(handle)).toBe(true);
    expect(read() - before).toBe(0);
  });

  it("is sliced by reading only the slice", async () => {
    const { handle, read } = await keptHandle();
    const before = read();
    const slice = await readSourceFileSlice(handle, 0, 100);
    expect(slice).toMatchObject({ size: SIZE });
    expect(slice.data).toHaveLength(100);
    expect(read() - before).toBe(100);
  });
});
