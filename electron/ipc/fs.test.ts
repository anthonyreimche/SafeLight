// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The fs:list channel: what the renderer is told when a folder can't be listed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fsChannels } from "./fs.cjs";

type Handler = (event: unknown, path: string) => Promise<{ name: string; kind: string }[]>;

function channel<T>(name: string, userData = ""): T {
  const channels = fsChannels({
    userData: () => userData,
    fileWriter: {},
    shell: {},
    dialog: {},
    BrowserWindow: {},
  } as never) as { channel: string; handler: T }[];
  return channels.find((c) => c.channel === name)!.handler;
}

const listHandler = () => channel<Handler>("fs:list");

const temps: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "safelight-fs-"));
  temps.push(dir);
  return dir;
}

/** A folder link: a junction on Windows (no admin rights needed), a symlink elsewhere. */
const linkFolder = (target: string, link: string) =>
  fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const rejection = (code: string, message: string) =>
  Object.assign(new Error(message), { code });

afterEach(() => vi.restoreAllMocks());

describe("fs:list", () => {
  it("answers a missing folder with an empty list", async () => {
    vi.spyOn(fs.promises, "readdir").mockRejectedValue(rejection("ENOENT", "ENOENT: no such file"));
    await expect(listHandler()({}, "/gone")).resolves.toEqual([]);
  });

  it.each(["EACCES", "EPERM"])("fails %s with the errno leading the message", async (code) => {
    vi.spyOn(fs.promises, "readdir").mockRejectedValue(
      rejection(code, `${code}: permission denied, scandir '/locked'`),
    );
    await expect(listHandler()({}, "/locked")).rejects.toThrow(new RegExp(`^${code}:`));
  });

  it("puts the errno first when the system's message leaves it out", async () => {
    vi.spyOn(fs.promises, "readdir").mockRejectedValue(rejection("EACCES", "permission denied"));
    await expect(listHandler()({}, "/locked")).rejects.toThrow(/^EACCES: permission denied/);
  });

  it("passes an error with no errno through untouched", async () => {
    const odd = new Error("odd");
    vi.spyOn(fs.promises, "readdir").mockRejectedValue(odd);
    await expect(listHandler()({}, "/x")).rejects.toBe(odd);
  });

  const sizedList = channel<
    (event: unknown, p: string, root?: string, withSizes?: boolean) => Promise<{ name: string; kind: string }[]>
  >("fs:list");

  it("gives each file its size when asked", async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, "a.jpg"), "12345");
    fs.mkdirSync(path.join(root, "sub"));
    const listed = await sizedList({}, root, undefined, true);
    expect(listed.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "a.jpg", kind: "file", size: 5 },
      { name: "sub", kind: "directory" },
    ]);
  });

  it("lists plain files without a stat each unless sizes are asked for", async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, "a.jpg"), "12345");
    const stat = vi.spyOn(fs.promises, "stat");
    await expect(listHandler()({}, root)).resolves.toEqual([{ name: "a.jpg", kind: "file" }]);
    expect(stat).not.toHaveBeenCalled();
    await sizedList({}, root, undefined, true);
    expect(stat).toHaveBeenCalledTimes(1);
  });

  it("stats at most 16 files at a time, in the order listed", async () => {
    const root = tempDir();
    const names = Array.from({ length: 40 }, (_, i) => `p${String(i).padStart(2, "0")}.jpg`);
    for (const name of names) fs.writeFileSync(path.join(root, name), "123");
    const stat = fs.promises.stat;
    let running = 0;
    let most = 0;
    vi.spyOn(fs.promises, "stat").mockImplementation(async (p, options) => {
      most = Math.max(most, ++running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running--;
      return stat(p, options);
    });

    const listed = await sizedList({}, root, undefined, true);

    expect(most).toBeLessThanOrEqual(16);
    expect(listed.map((e) => e.name)).toEqual(fs.readdirSync(root));
  });

  it("lists a linked folder as the folder it links to", async () => {
    const root = tempDir();
    const elsewhere = tempDir();
    fs.writeFileSync(path.join(elsewhere, "b.jpg"), "123");
    linkFolder(elsewhere, path.join(root, "linked"));
    await expect(listHandler()({}, root)).resolves.toEqual([{ name: "linked", kind: "directory" }]);
    await expect(listHandler()({}, path.join(root, "linked"))).resolves.toEqual([
      { name: "b.jpg", kind: "file" },
    ]);
  });

  it.skipIf(process.platform === "win32")("lists a linked file as a file of its target's size", async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, "a.jpg"), "1234");
    fs.symlinkSync(path.join(root, "a.jpg"), path.join(root, "b.jpg"));
    const listed = await sizedList({}, root, undefined, true);
    expect(listed.find((e) => e.name === "b.jpg")).toEqual({ name: "b.jpg", kind: "file", size: 4 });
  });

  it("lists a broken link as a folder that can't be listed, not as an empty one", async () => {
    const root = tempDir();
    const gone = tempDir();
    linkFolder(gone, path.join(root, "gone"));
    fs.rmSync(gone, { recursive: true });
    await expect(listHandler()({}, root)).resolves.toEqual([{ name: "gone", kind: "directory" }]);
    await expect(listHandler()({}, path.join(root, "gone"))).rejects.toThrow(/^ENOENT:/);
  });

  it("leaves out a link back to a folder above it, which would walk forever", async () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, "a"));
    linkFolder(root, path.join(root, "a", "up"));
    linkFolder(path.join(root, "a"), path.join(root, "a", "self"));
    await expect(listHandler()({}, path.join(root, "a"))).resolves.toEqual([]);
  });

  it("leaves out a link into the project folder it is listed for, whose photos the walk finds anyway", async () => {
    const root = tempDir();
    const elsewhere = tempDir();
    fs.mkdirSync(path.join(root, "real"));
    fs.mkdirSync(path.join(root, "a"));
    linkFolder(path.join(root, "real"), path.join(root, "a", "inside"));
    linkFolder(elsewhere, path.join(root, "a", "outside"));
    const list = channel<(event: unknown, p: string, root?: string) => Promise<{ name: string }[]>>("fs:list");
    await expect(list({}, path.join(root, "a"), root)).resolves.toEqual([{ name: "outside", kind: "directory" }]);
    expect((await list({}, path.join(root, "a"))).map((e) => e.name).sort()).toEqual(["inside", "outside"]);
  });
});

describe("fs:externalCatalogDir", () => {
  type Resolve = (
    event: unknown,
    rootPath: string,
    base: string | null,
    create: boolean,
    variant?: number,
  ) => Promise<string | null>;
  type ListCatalogs = (event: unknown, base: string | null) => Promise<{ path: string; sourcePath: string | null }[]>;

  it("gives a source a second catalogue of its own beside the first", async () => {
    const userData = tempDir();
    const resolve = channel<Resolve>("fs:externalCatalogDir", userData);
    const first = await resolve({}, "E:\\", null, true);
    const second = await resolve({}, "E:\\", null, true, 2);
    expect(second).not.toBe(first);
    expect(path.basename(path.dirname(second!))).toBe(`${path.basename(path.dirname(first!))}-2`);
    await expect(resolve({}, "E:\\", null, false, 2)).resolves.toBeNull();
    fs.writeFileSync(path.join(second!, "catalog.json"), "{}");
    await expect(resolve({}, "E:\\", null, false, 2)).resolves.toBe(second);

    const listed = await channel<ListCatalogs>("fs:listExternalCatalogs", userData)({}, null);
    expect(listed.map((c) => c.path).sort()).toEqual([path.dirname(first!), path.dirname(second!)].sort());
    expect(listed.every((c) => c.sourcePath === path.resolve("E:\\"))).toBe(true);
  });

  it("names every catalogue a source keeps, past one deleted before it", async () => {
    const userData = tempDir();
    const resolve = channel<Resolve>("fs:externalCatalogDir", userData);
    const variants = channel<(event: unknown, rootPath: string, base: string | null) => Promise<number[]>>(
      "fs:externalCatalogVariants",
      userData,
    );
    for (const n of [1, 2, 3]) {
      const dir = await resolve({}, "E:\\", null, true, n);
      fs.writeFileSync(path.join(dir!, "catalog.json"), "{}");
    }
    await resolve({}, "F:\\", null, true);
    fs.writeFileSync(path.join((await resolve({}, "E:\\", null, true, 4))!, "x"), "no catalogue yet");
    fs.rmSync(path.dirname((await resolve({}, "E:\\", null, true))!), { recursive: true });

    await expect(variants({}, "E:\\", null)).resolves.toEqual([2, 3]);
  });

  it("tells a source's catalogues apart by what their card held", async () => {
    const userData = tempDir();
    const dir = (await channel<Resolve>("fs:externalCatalogDir", userData)({}, "E:\\", null, true))!;
    const print = {
      source: path.resolve("E:\\"),
      createdAt: 1,
      photos: 120,
      openedAt: 99,
      volume: ["DCIM/100CANON/IMG_0001.CR3", "DCIM/100CANON/IMG_0050.CR3", "DCIM/100CANON/IMG_0099.CR3", "x/IMG_0120.CR3"].map(
        (relPath) => ({ relPath, size: 1 }),
      ),
    };
    fs.writeFileSync(path.join(path.dirname(dir), "source.json"), JSON.stringify(print));

    const [listed] = await channel<ListCatalogs>("fs:listExternalCatalogs", userData)({}, null);
    expect(listed).toMatchObject({
      photoCount: 120,
      lastOpenedAt: 99,
      sampleNames: ["IMG_0001.CR3", "IMG_0050.CR3", "IMG_0099.CR3"],
    });
  });
});
