// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A memory card reaches extensions without a picker, so its folder handles only
// read: nothing on the card can be written, made or removed through them, and
// they carry no path core's own path-based code would act on.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryFs } from "./memory-fs.test-support";

const h = vi.hoisted(() => ({ fs: null as unknown }));
vi.mock("@/native/privileged", () => ({ privilegedFs: () => h.fs }));

import { nativeCardHandle, nativePathOf, readFileSlice } from "./native-fs";

let fs: MemoryFs;

beforeEach(() => {
  fs = new MemoryFs("/card", "/card/DCIM/100NIKON");
  fs.putBytes("/card/DCIM/100NIKON/DSC_1.NEF", new Uint8Array([1, 2, 3, 4, 5]));
  h.fs = fs;
});

async function entries(dir: FileSystemDirectoryHandle): Promise<FileSystemHandle[]> {
  const out: FileSystemHandle[] = [];
  for await (const entry of (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) out.push(entry);
  return out;
}

describe("nativeCardHandle", () => {
  it("lists and reads the card", async () => {
    const card = nativeCardHandle("/card");
    expect(card.name).toBe("card");
    const dcim = await card.getDirectoryHandle("DCIM");
    const [folder] = await entries(dcim);
    expect(folder).toMatchObject({ kind: "directory", name: "100NIKON" });
    const [file] = await entries(folder as FileSystemDirectoryHandle);
    const read = await (file as FileSystemFileHandle).getFile();
    expect(read.name).toBe("DSC_1.NEF");
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it("offers no way to write, make or remove anything, at any depth", async () => {
    const card = nativeCardHandle("/card");
    const dcim = await card.getDirectoryHandle("DCIM", { create: true });
    const [folder] = await entries(dcim);
    const file = await (folder as FileSystemDirectoryHandle).getFileHandle("DSC_1.NEF", { create: true });
    for (const dir of [card, dcim, folder]) expect("removeEntry" in dir).toBe(false);
    expect("createWritable" in file).toBe(false);
    await expect(card.getDirectoryHandle("new", { create: true })).rejects.toThrow();
    await expect(card.getFileHandle("new.jpg", { create: true })).rejects.toThrow();
    expect(fs.tree("/card")).toEqual(["/card/DCIM/100NIKON/DSC_1.NEF"]);
  });

  it("carries no path, so path-based code can't act on the card", async () => {
    const card = nativeCardHandle("/card");
    const dcim = await card.getDirectoryHandle("DCIM");
    const [folder] = await entries(dcim);
    const [file] = await entries(folder as FileSystemDirectoryHandle);
    for (const handle of [card, dcim, folder, file]) expect(nativePathOf(handle)).toBeNull();
  });

  it("is range-read by readFileSlice", async () => {
    const folder = await (await nativeCardHandle("/card").getDirectoryHandle("DCIM")).getDirectoryHandle("100NIKON");
    const file = await folder.getFileHandle("DSC_1.NEF");
    const slice = await readFileSlice(file, 1, 3);
    expect(slice).toMatchObject({ data: new Uint8Array([2, 3]), size: 5 });
    expect(fs.bytesRead("/card/DCIM/100NIKON/DSC_1.NEF")).toBe(2);
  });

  it("refuses names that climb out of the card", async () => {
    const card = nativeCardHandle("/card");
    await expect(card.getDirectoryHandle("..")).rejects.toThrow();
    await expect(card.getFileHandle("../x.jpg")).rejects.toThrow();
  });
});
