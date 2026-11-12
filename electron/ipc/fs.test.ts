// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The fs:* channels: what the renderer is told when a folder can't be listed, and
// which paths the mutating channels refuse to touch.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAtomicWriter } from "../atomic-write.cjs";
import { fsChannels } from "./fs.cjs";

type Handler = (event: unknown, path: string) => Promise<{ name: string; kind: string }[]>;

type Deps = { fileWriter?: object; shell?: object };

function channel<T>(name: string, userData = "", deps: Deps = {}): T {
  const channels = fsChannels({
    userData: () => userData,
    fileWriter: {},
    shell: {},
    dialog: {},
    BrowserWindow: {},
    ...deps,
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

describe("fs:sourceCatalogDir", () => {
  type Resolve = (event: unknown, key: string, name: string) => Promise<string>;

  it("keeps one catalogue per source and library under the app data, named after the source", async () => {
    const userData = tempDir();
    const resolve = channel<Resolve>("fs:sourceCatalogDir", userData);
    const dir = await resolve({}, "immich\nhttp://nas:2283#u1", "Immich");
    expect(path.basename(dir)).toBe(".safelight");
    expect(path.dirname(path.dirname(dir))).toBe(path.join(userData, "source-catalogs"));
    expect(path.basename(path.dirname(dir))).toMatch(/^Immich-[0-9a-f]{8}$/);
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    await expect(resolve({}, "immich\nhttp://nas:2283#u1", "Immich")).resolves.toBe(dir);
    await expect(resolve({}, "immich\nhttp://nas:2283#u2", "Immich")).resolves.not.toBe(dir);
  });

  it("makes a plain folder name of any source name", async () => {
    const dir = await channel<Resolve>("fs:sourceCatalogDir", tempDir())({}, "k", "../a b:c");
    expect(path.basename(path.dirname(dir))).toMatch(/^\.\._a_b_c-[0-9a-f]{8}$/);
  });
});

describe("mutating fs channels", () => {
  type OnePath = (event: unknown, p: string) => Promise<void>;
  type Write = (event: unknown, p: string, data: Uint8Array) => Promise<void>;
  type Move = (event: unknown, src: string, dest: string) => Promise<void>;

  const root = path.parse(os.tmpdir()).root;

  it("marks every channel privileged", () => {
    const channels = fsChannels({} as never) as { privileged: boolean }[];
    expect(channels.every((c) => c.privileged === true)).toBe(true);
  });

  it.each(["undefined", "", root])("fs:remove refuses %j and removes nothing", async (p) => {
    const rm = vi.spyOn(fs.promises, "rm").mockResolvedValue();
    await expect(channel<OnePath>("fs:remove")({}, p)).rejects.toThrow(Error);
    expect(rm).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== "win32")("fs:remove refuses a network share's root", async () => {
    const rm = vi.spyOn(fs.promises, "rm").mockResolvedValue();
    await expect(channel<OnePath>("fs:remove")({}, "\\\\server\\share\\")).rejects.toThrow(Error);
    expect(rm).not.toHaveBeenCalled();
  });

  it("fs:remove still removes a folder", async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "a.json"), "{}");
    await channel<OnePath>("fs:remove")({}, dir);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it.each(["rel/x", root])("fs:trash refuses %j", async (p) => {
    const trashItem = vi.fn().mockResolvedValue(undefined);
    await expect(channel<OnePath>("fs:trash", "", { shell: { trashItem } })({}, p)).rejects.toThrow(Error);
    expect(trashItem).not.toHaveBeenCalled();
  });

  it("fs:move refuses a relative source or a root destination", async () => {
    const rename = vi.spyOn(fs.promises, "rename").mockResolvedValue();
    const mkdir = vi.spyOn(fs.promises, "mkdir").mockResolvedValue(undefined);
    const dir = path.join(os.tmpdir(), "safelight-fs-move");
    const move = channel<Move>("fs:move");
    await expect(move({}, "rel/a.jpg", path.join(dir, "a.jpg"))).rejects.toThrow(Error);
    await expect(move({}, path.join(dir, "a.jpg"), root)).rejects.toThrow(Error);
    await expect(move({}, root, path.join(dir, "a.jpg"))).rejects.toThrow(Error);
    expect(rename).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
  });

  it.each(["", "rel/file.json"])("fs:write refuses %j", async (p) => {
    const write = vi.fn().mockResolvedValue(undefined);
    const handler = channel<Write>("fs:write", "", { fileWriter: { write } });
    await expect(handler({}, p, new Uint8Array([1]))).rejects.toThrow(Error);
    expect(write).not.toHaveBeenCalled();
  });

  it("fs:mkdir refuses a relative path", async () => {
    const mkdir = vi.spyOn(fs.promises, "mkdir").mockResolvedValue(undefined);
    await expect(channel<OnePath>("fs:mkdir")({}, "rel")).rejects.toThrow(Error);
    expect(mkdir).not.toHaveBeenCalled();
  });
});

describe("fs:setSpilloverPointer", () => {
  type Set = (event: unknown, rootPath: string, spilloverDir: string) => Promise<void>;
  type Get = (event: unknown, rootPath: string) => Promise<string | null>;

  it("hands the pointer to the shared atomic writer", async () => {
    const userData = tempDir();
    const write = vi.fn().mockResolvedValue(undefined);
    await channel<Set>("fs:setSpilloverPointer", userData, { fileWriter: { write } })({}, "D:/card", "D:/x/.safelight");

    const tag = crypto.createHash("sha1").update(path.resolve("D:/card")).digest("hex");
    expect(write).toHaveBeenCalledTimes(1);
    const [file, bytes] = write.mock.calls[0] as [string, Uint8Array];
    expect(file).toBe(path.join(userData, "external-catalogs", ".pointers", `${tag}.json`));
    expect(JSON.parse(Buffer.from(bytes).toString("utf8"))).toEqual({
      source: path.resolve("D:/card"),
      spillover: "D:/x/.safelight",
    });
  });

  it("fails when the write fails", async () => {
    const write = vi.fn().mockRejectedValue(new Error("disk full"));
    const set = channel<Set>("fs:setSpilloverPointer", tempDir(), { fileWriter: { write } });
    await expect(set({}, "D:/card", "D:/x/.safelight")).rejects.toThrow("disk full");
  });

  it("is found again by fs:getSpilloverPointer", async () => {
    const userData = tempDir();
    const fileWriter = createAtomicWriter({
      fsp: fs.promises,
      randomId: () => crypto.randomBytes(8).toString("hex"),
      retry: (op: () => Promise<void>) => op(),
    });
    await channel<Set>("fs:setSpilloverPointer", userData, { fileWriter })({}, "D:/card", "D:/x/.safelight");
    await expect(channel<Get>("fs:getSpilloverPointer", userData)({}, "D:/card")).resolves.toBe("D:/x/.safelight");
  });
});

// A folder an extension keeps across launches (kept-folders.cjs): picked in the
// native dialog, named to the extension by a token alone.
describe("fs:pickKeptFolder", () => {
  type Pick = (event: unknown, id: string, replacing: string | null) => Promise<{ token: string; path: string } | null>;
  type Open = (event: unknown, id: string, token: string) => Promise<{ path?: string; error?: string }>;

  function table(answer: string | null) {
    const showOpenDialog = vi.fn(async () => ({ canceled: answer === null, filePaths: answer ? [answer] : [] }));
    const channels = fsChannels({
      userData: () => tempDir(),
      fileWriter: { write: async () => undefined },
      shell: {},
      dialog: { showOpenDialog },
      BrowserWindow: { fromWebContents: () => null },
    } as never) as { channel: string; handler: unknown }[];
    const find = <T>(name: string) => channels.find((c) => c.channel === name)!.handler as T;
    return { showOpenDialog, pick: find<Pick>("fs:pickKeptFolder"), open: find<Open>("fs:keptFolder") };
  }

  it("keeps the folder picked in the native dialog, opening it at the one it replaces", async () => {
    const out = tempDir();
    const { pick, open, showOpenDialog } = table(out);
    const first = await pick({ sender: {} }, "ext.recipes", null);
    expect(first?.path).toBe(out);
    await expect(open({}, "ext.recipes", first!.token)).resolves.toEqual({ path: out });

    await pick({ sender: {} }, "ext.recipes", first!.token);
    const asked = showOpenDialog.mock.calls.map((call) => (call as unknown[])[1]);
    expect(asked).toEqual([
      { properties: ["openDirectory"] },
      { properties: ["openDirectory"], defaultPath: out },
    ]);
  });

  it("keeps nothing when the dialog is cancelled", async () => {
    const { pick } = table(null);
    await expect(pick({ sender: {} }, "ext.recipes", null)).resolves.toBeNull();
  });
});
