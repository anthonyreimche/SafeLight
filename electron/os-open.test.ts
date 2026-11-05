// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// "Open with Safelight" from the file manager hands the app paths on its command
// line (or macOS's open-file event). A project is a folder, so a path becomes the
// folder to open and, for a file, the photo to select once it has loaded.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import types from "./photo-types.json";
import { argvPaths, createRequestOrder, openTargetFor, withoutPaths } from "./os-open.cjs";

describe("argvPaths", () => {
  const cwd = path.resolve("/work");
  const photo = path.resolve("/photos/a.NEF");

  it("takes the paths after the executable of a packaged app", () => {
    expect(argvPaths(["safelight", photo], { defaultApp: false, cwd })).toEqual([photo]);
  });

  it("also skips the app folder electron is started with in development", () => {
    expect(argvPaths(["electron", ".", photo], { defaultApp: true, cwd })).toEqual([photo]);
  });

  it("leaves out flags, including the GPU probe rung the app relaunches itself with", () => {
    const argv = ["safelight", "--safelight-angle-idx=1", "--no-sandbox", photo];
    expect(argvPaths(argv, { defaultApp: false, cwd })).toEqual([photo]);
  });

  it("resolves a relative path against the directory the launch came from", () => {
    expect(argvPaths(["safelight", "shots/b.jpg"], { defaultApp: false, cwd })).toEqual([
      path.join(cwd, "shots", "b.jpg"),
    ]);
  });

  // Linux file managers launch `Exec=safelight %U` with file:// URIs.
  it("reads a file:// URI as the path it names", () => {
    const uri = pathToFileURL(photo).href;
    expect(argvPaths(["safelight", uri], { defaultApp: false, cwd })).toEqual([photo]);
  });

  it("decodes the escapes in a file:// URI", () => {
    const spaced = path.resolve("/my photos/a b.NEF");
    expect(argvPaths(["safelight", pathToFileURL(spaced).href], { defaultApp: false, cwd })).toEqual([spaced]);
  });

  it("leaves out a file: URI that cannot be read as a path", () => {
    expect(argvPaths(["safelight", "file:///%zz"], { defaultApp: false, cwd })).toEqual([]);
  });

  it("lists a path once and skips empty arguments", () => {
    expect(argvPaths(["safelight", photo, "", photo], { defaultApp: false, cwd })).toEqual([photo]);
  });
});

describe("openTargetFor", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-os-open-"));
    file = path.join(dir, "a.NEF");
    await fsp.writeFile(file, "x");
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("opens a folder as itself, with no photo to select", async () => {
    expect(await openTargetFor([dir])).toEqual({ folder: dir, file: null });
  });

  it("opens a file's folder and names the file to select", async () => {
    expect(await openTargetFor([file])).toEqual({ folder: dir, file: "a.NEF" });
  });

  it("skips a path that is not there and takes the next that is", async () => {
    const gone = path.join(dir, "gone.NEF");
    expect(await openTargetFor([gone, file])).toEqual({ folder: dir, file: "a.NEF" });
  });

  it("opens a photo of any supported kind whatever its case", async () => {
    for (const name of ["a.jpg", "b.JPEG", "c.Tif", "d.webp", "e.CR3", "f.dng", "g.RAF"]) {
      const photoPath = path.join(dir, name);
      await fsp.writeFile(photoPath, "x");
      expect(await openTargetFor([photoPath])).toEqual({ folder: dir, file: name });
    }
  });

  it("opens every type the importer accepts, including avif, ppm and the rarer RAWs", async () => {
    const exts = [...Object.keys(types.standard), ...Object.keys(types.raw)];
    for (const ext of [".avif", ".ppm", ".iiq", ".3fr", ".mdc", ...exts]) {
      const photoPath = path.join(dir, `p${ext}`);
      await fsp.writeFile(photoPath, "x");
      expect(await openTargetFor([photoPath])).toEqual({ folder: dir, file: `p${ext}` });
    }
  });

  it("does not open the folder of a file that is no photo", async () => {
    const notes = path.join(dir, "notes.txt");
    await fsp.writeFile(notes, "x");
    expect(await openTargetFor([notes])).toBeNull();
  });

  it("skips a file that is no photo and takes the next path", async () => {
    const notes = path.join(dir, "notes.txt");
    await fsp.writeFile(notes, "x");
    expect(await openTargetFor([notes, file])).toEqual({ folder: dir, file: "a.NEF" });
  });

  it("is null when nothing exists or nothing was given", async () => {
    expect(await openTargetFor([path.join(dir, "gone.NEF")])).toBeNull();
    expect(await openTargetFor([])).toBeNull();
  });
});

describe("withoutPaths", () => {
  it("keeps the executable, the dev app folder and flags, and drops the paths", () => {
    const photo = path.resolve("/photos/a.NEF");
    const argv = ["electron", ".", photo, "--safelight-angle-idx=1", "--no-sandbox"];
    expect(withoutPaths(argv, { defaultApp: true })).toEqual([
      "electron",
      ".",
      "--safelight-angle-idx=1",
      "--no-sandbox",
    ]);
    expect(withoutPaths(["safelight", photo, "--x"], { defaultApp: false })).toEqual(["safelight", "--x"]);
  });
});

// Each request is resolved by an async stat, so they can finish out of order.
describe("createRequestOrder", () => {
  it("lets a request that finishes in order land", () => {
    const begin = createRequestOrder();
    const first = begin();
    const second = begin();
    expect(first()).toBe(true);
    expect(second()).toBe(true);
  });

  it("drops an earlier request that finishes after a later one landed", () => {
    const begin = createRequestOrder();
    const first = begin();
    const second = begin();
    expect(second()).toBe(true);
    expect(first()).toBe(false);
  });

  it("lets an earlier request land when the later one never did", () => {
    const begin = createRequestOrder();
    const first = begin();
    begin();
    expect(first()).toBe(true);
  });
});
