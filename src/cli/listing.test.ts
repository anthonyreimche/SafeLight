// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The disk listing on temp trees, through the real Node host and ProjectStorage.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredPhoto } from "@/catalog/types";
import { installNodeHost } from "./host";
import { listPaths, type ListRequest, type Listing } from "./listing";
import { createNodeFsBridge } from "./node-fs";
import { createProjectService } from "./project";
import type { CliEnv } from "./types";

class FakeChannel {
  postMessage(message: unknown): void {
    structuredClone(message);
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

let temp: string;
let root: string;
let userData: string;
let env: CliEnv;

const record = (id: string, relPath: string, extra: Partial<StoredPhoto> = {}): StoredPhoto => ({
  id,
  filename: path.posix.basename(relPath),
  relPath,
  folder: path.posix.dirname(relPath) === "." ? "" : path.posix.dirname(relPath),
  width: 6000,
  height: 4000,
  fileSize: 100,
  mimeType: "image/x-sony-arw",
  rating: 0,
  colorLabel: "none",
  flag: "none",
  rotation: 0,
  keywords: [],
  dateCreated: 1,
  dateImported: 2,
  exif: { colorTemperature: 5200 },
  ...extra,
});

const touch = (rel: string, bytes = 10): void => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes));
};

/** root/
 *    a.ARW       imported, 5 stars, pick, red
 *    b.ARW       not imported
 *    c.ARW       removed from the catalogue
 *    notes.txt   other file
 *    day1/d.ARW  record, file gone
 *    day1/e.ARW  imported, edited
 *    day1/f.ARW  not imported
 *    day2/g.ARW, day2/h.ARW  not imported
 *    day2/deep/i.ARW         imported */
function seed(): void {
  for (const rel of ["a.ARW", "b.ARW", "c.ARW", "notes.txt", "day1/e.ARW", "day1/f.ARW", "day2/g.ARW", "day2/h.ARW", "day2/deep/i.ARW"]) touch(rel);
  fs.mkdirSync(path.join(root, ".safelight"));
  const catalog = {
    version: 2,
    id: "cat-1",
    photos: [
      record("a", "a.ARW", { rating: 5, flag: "pick", colorLabel: "red", dateCreated: 30 }),
      record("d", "day1/d.ARW", { dateCreated: 20 }),
      record("e", "day1/e.ARW", { rating: 2, dateCreated: 10 }),
      record("i", "day2/deep/i.ARW", { rating: 3, dateCreated: 40, fileSize: 999 }),
    ],
    edits: [{
      photoId: "e",
      currentIndex: 1,
      stack: [
        { label: "Original", timestamp: 1, params: {}, paramBag: {} },
        { label: "Exposure", timestamp: 2, params: {}, paramBag: {} },
      ],
    }],
    removed: ["c.ARW"],
  };
  fs.writeFileSync(path.join(root, ".safelight", "catalog.json"), JSON.stringify(catalog));
}

const request = (over: Partial<ListRequest> = {}): ListRequest => ({
  specs: [],
  cwd: root,
  platform: process.platform,
  recursive: false,
  tree: false,
  depth: Infinity,
  sort: "name",
  reverse: false,
  states: [],
  filters: {},
  all: false,
  projectOverride: null,
  ...over,
});

const list = (over: Partial<ListRequest> = {}): Promise<Listing> => {
  const projects = createProjectService(env, createNodeFsBridge(userData));
  return listPaths({ env, projects }, request(over));
};

const names = (l: Listing): string[] => l.photos.map((p) => p.name);
const states = (l: Listing): Record<string, string> => Object.fromEntries(l.photos.map((p) => [p.name, p.state]));

beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "slu-ls-"));
  root = path.join(temp, "shoot");
  userData = path.join(temp, "userData");
  fs.mkdirSync(userData);
  fs.mkdirSync(root);
  env = {
    cwd: root, userData, appRoot: temp, electronBinary: null, appVersion: "0", platform: process.platform,
    isTTY: { stdin: false, stdout: false, stderr: false }, env: {},
  };
  installNodeHost({ bridge: createNodeFsBridge(userData), platform: process.platform, storage: {} });
  vi.stubGlobal("BroadcastChannel", FakeChannel);
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "localStorage");
  fs.rmSync(temp, { recursive: true, force: true });
});

describe("listPaths states", () => {
  beforeEach(seed);

  it("tells imported, new, removed and missing apart", async () => {
    const l = await list();
    expect(states(l)).toEqual({ "a.ARW": "imported", "b.ARW": "new", "c.ARW": "removed" });
    const deep = await list({ recursive: true });
    expect(states(deep)).toMatchObject({
      "day1/d.ARW": "missing",
      "day1/e.ARW": "imported",
      "day1/f.ARW": "new",
      "day2/deep/i.ARW": "imported",
    });
  });

  it("reads rating, flag, label, edited and step from the record", async () => {
    const l = await list({ recursive: true });
    const a = l.photos.find((p) => p.name === "a.ARW");
    expect(a).toMatchObject({ edited: false, path: path.join(root, "a.ARW"), relPath: "a.ARW" });
    expect(a?.photo).toMatchObject({ rating: 5, flag: "pick", colorLabel: "red" });
    expect(l.photos.find((p) => p.name === "day1/e.ARW")).toMatchObject({ edited: true, step: 1 });
  });

  it("counts files that aren't photos, not listing them", async () => {
    const l = await list();
    expect(l.otherFiles).toBe(1);
    expect(names(l)).not.toContain("notes.txt");
  });

  it("folds case where the file system does", async () => {
    if (process.platform !== "win32" && process.platform !== "darwin") return;
    const catalog = JSON.parse(fs.readFileSync(path.join(root, ".safelight", "catalog.json"), "utf8"));
    catalog.photos[0].relPath = "A.arw";
    fs.writeFileSync(path.join(root, ".safelight", "catalog.json"), JSON.stringify(catalog));
    expect((await list()).photos.find((p) => p.name === "a.ARW")?.state).toBe("imported");
  });
});

describe("listPaths folders", () => {
  beforeEach(seed);

  it("counts each folder's whole subtree", async () => {
    const l = await list();
    expect(l.folders.map((f) => ({ name: f.name, photos: f.photos, imported: f.imported, edited: f.edited, picks: f.picks, new: f.new }))).toEqual([
      { name: "day1", photos: 3, imported: 2, edited: 1, picks: 0, new: 1 },
      { name: "day2", photos: 3, imported: 1, edited: 0, picks: 0, new: 2 },
    ]);
  });

  it("lists a subfolder's own photos and folders, named from it", async () => {
    const l = await list({ specs: ["day2"] });
    expect(names(l)).toEqual(["g.ARW", "h.ARW"]);
    expect(l.folders.map((f) => [f.name, f.photos])).toEqual([["deep", 1]]);
    expect(l.folder).toBe(path.join(root, "day2"));
    expect(l.project?.root).toBe(root);
  });

  it("goes into subfolders with -r, naming photos from the folder listed", async () => {
    const l = await list({ specs: ["day2"], recursive: true });
    expect(names(l)).toEqual(["deep/i.ARW", "g.ARW", "h.ARW"]);
    expect(l.folders).toEqual([]);
  });

  it("gives the nested folders for --tree, with depth, and stops at --depth", async () => {
    const all = await list({ tree: true });
    expect(all.photos).toEqual([]);
    expect(all.folders.map((f) => [f.relPath, f.depth])).toEqual([["", 0], ["day1", 1], ["day2", 1], ["day2/deep", 2]]);
    expect(all.folders[0]).toMatchObject({ photos: 8, new: 4, edited: 1, picks: 1 });
    const one = await list({ tree: true, depth: 1 });
    expect(one.folders.map((f) => f.relPath)).toEqual(["", "day1", "day2"]);
  });

  it("keeps folders that hold no photo", async () => {
    fs.mkdirSync(path.join(root, "empty"));
    expect((await list()).folders.map((f) => [f.name, f.photos])).toContainEqual(["empty", 0]);
  });
});

describe("listPaths filters and order", () => {
  beforeEach(seed);

  it("filters by state, and a union of states", async () => {
    expect(names(await list({ recursive: true, states: ["new"] }))).toEqual(["b.ARW", "day1/f.ARW", "day2/g.ARW", "day2/h.ARW"]);
    expect(names(await list({ recursive: true, states: ["removed"] }))).toEqual(["c.ARW"]);
    expect(names(await list({ recursive: true, states: ["missing"] }))).toEqual(["day1/d.ARW"]);
    expect(names(await list({ recursive: true, states: ["new", "missing"] }))).toEqual(["b.ARW", "day1/d.ARW", "day1/f.ARW", "day2/g.ARW", "day2/h.ARW"]);
  });

  it("makes a catalogue filter mean photos in the catalogue", async () => {
    expect(names(await list({ recursive: true, filters: { rating: { min: 3, max: 5 } } }))).toEqual(["a.ARW", "day2/deep/i.ARW"]);
    expect(names(await list({ recursive: true, filters: { flag: "pick" } }))).toEqual(["a.ARW"]);
    expect(names(await list({ recursive: true, filters: { label: "red" } }))).toEqual(["a.ARW"]);
    expect(names(await list({ recursive: true, filters: { edited: true } }))).toEqual(["day1/e.ARW"]);
    expect(names(await list({ recursive: true, filters: { edited: false } }))).toEqual(["a.ARW", "day1/d.ARW", "day2/deep/i.ARW"]);
  });

  it("counts folders over the matches only, hiding folders with none", async () => {
    const l = await list({ states: ["new"] });
    expect(l.folders.map((f) => [f.name, f.photos, f.new])).toEqual([["day1", 1, 1], ["day2", 2, 2]]);
    const picks = await list({ filters: { flag: "pick" } });
    expect(picks.folders).toEqual([]);
  });

  it("sorts by name, naturally, and reverses", async () => {
    touch("img2.ARW");
    touch("img10.ARW");
    expect(names(await list())).toEqual(["a.ARW", "b.ARW", "c.ARW", "img2.ARW", "img10.ARW"]);
    expect(names(await list({ reverse: true }))).toEqual(["img10.ARW", "img2.ARW", "c.ARW", "b.ARW", "a.ARW"]);
  });

  it("sorts by rating, date, size, edited and imported, unknowns last", async () => {
    const all = { recursive: true, states: ["imported", "missing"] as ListRequest["states"] };
    expect(names(await list({ ...all, sort: "rating" }))).toEqual(["day1/d.ARW", "day1/e.ARW", "day2/deep/i.ARW", "a.ARW"]);
    expect(names(await list({ ...all, sort: "date" }))).toEqual(["day1/e.ARW", "day1/d.ARW", "a.ARW", "day2/deep/i.ARW"]);
    expect(names(await list({ ...all, sort: "edited" }))[0]).toBe("day1/e.ARW");
    const size = await list({ recursive: true, sort: "size" });
    expect(names(size).at(-1)).toBe("day2/deep/i.ARW");
    const imported = await list({ recursive: true, sort: "imported" });
    expect(names(imported).slice(-5)).toEqual(["b.ARW", "c.ARW", "day1/f.ARW", "day2/g.ARW", "day2/h.ARW"]);
  });
});

describe("listPaths specs", () => {
  beforeEach(seed);

  it("expands a glob over files the catalogue doesn't hold", async () => {
    const l = await list({ specs: ["*.ARW"] });
    expect(names(l)).toEqual(["a.ARW", "b.ARW", "c.ARW"]);
    expect(states(l)["b.ARW"]).toBe("new");
    expect(l.problems).toEqual([]);
  });

  it("lists named files, new or not", async () => {
    const l = await list({ specs: ["b.ARW", "a.ARW"] });
    expect(names(l)).toEqual(["a.ARW", "b.ARW"]);
  });

  it("reports what wasn't found, matches nothing, or isn't a photo", async () => {
    const l = await list({ specs: ["nope.ARW", "*.XYZ", "notes.txt", "a.ARW"] });
    expect(l.problems.map((p) => [p.spec, p.reason])).toEqual([
      ["nope.ARW", "not-found"],
      ["*.XYZ", "no-match"],
      ["notes.txt", "not-a-photo"],
    ]);
    expect(names(l)).toEqual(["a.ARW"]);
  });

  it("finds the project from a subfolder", async () => {
    const l = await list({ cwd: path.join(root, "day1") });
    expect(names(l)).toEqual(["d.ARW", "e.ARW", "f.ARW"]);
    expect(l.project?.root).toBe(root);
  });

  it("lists the whole project with --all, from anywhere in it", async () => {
    const l = await list({ cwd: path.join(root, "day1"), all: true });
    expect(l.photos).toHaveLength(9);
    expect(l.folder).toBe(root);
  });

  it("writes nothing and takes no lock", async () => {
    const before = fs.readFileSync(path.join(root, ".safelight", "catalog.json"));
    await list({ recursive: true });
    expect(fs.readFileSync(path.join(root, ".safelight", "catalog.json")).equals(before)).toBe(true);
    expect(fs.existsSync(path.join(root, ".safelight", "writer.lock"))).toBe(false);
    expect(fs.readdirSync(path.join(root, ".safelight")).sort()).toEqual(["catalog.json"]);
  });
});

describe("listPaths outside a project", () => {
  it("calls every photo new, with no project", async () => {
    touch("x.ARW");
    touch("sub/y.ARW");
    const l = await list({ recursive: true });
    expect(l.project).toBeNull();
    expect(states(l)).toEqual({ "x.ARW": "new", "sub/y.ARW": "new" });
    expect(fs.existsSync(path.join(root, ".safelight"))).toBe(false);
  });

  it("lists an empty folder as nothing", async () => {
    const l = await list();
    expect(l.photos).toEqual([]);
    expect(l.folders).toEqual([]);
  });
});
