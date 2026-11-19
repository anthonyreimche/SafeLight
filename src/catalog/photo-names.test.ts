import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import photoTypes from "../../electron/photo-types.json";
import { isSupportedName as appIsSupportedName } from "@/modules/library/import-record";
import { folderSegments, isEntryName } from "@/project/entry-names";
import { isSupportedName } from "./photo-names";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const BANNED = /\.tsx$|^(ui|hooks|rendering|modules|state)\//;

function reach(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file) || file.endsWith(".json")) continue;
    seen.add(file);
    const code = readFileSync(file, "utf8");
    for (const m of code.matchAll(/^\s*(?:import|export)\s+(?!type\s)[^;]*?\s+from\s+["']([^"']+)["']/gm)) {
      const spec = m[1];
      if (!/^(\.|@\/)/.test(spec)) continue;
      const base = spec.startsWith("@/") ? path.join(SRC, spec.slice(2)) : path.resolve(path.dirname(file), spec);
      const next = [base, `${base}.ts`, `${base}.tsx`].find((f) => existsSync(f) && /\.(ts|tsx|json)$/.test(f));
      if (next) queue.push(next);
    }
  }
  return [...seen, ...[...seen].filter((f) => f.endsWith(".json"))].map((f) => path.relative(SRC, f).split(path.sep).join("/"));
}

describe("isSupportedName", () => {
  const extensions = [...Object.keys(photoTypes.standard), ...Object.keys(photoTypes.raw)];

  it("accepts every extension photo-types.json lists, in any case", () => {
    for (const ext of extensions) {
      expect(isSupportedName(`IMG_0001${ext}`), ext).toBe(true);
      expect(isSupportedName(`IMG_0001${ext.toUpperCase()}`), ext).toBe(true);
    }
  });

  it("agrees with the app's rule on photo and non-photo names", () => {
    const names = [
      ...extensions.map((e) => `a${e}`),
      "DSC_0001.NEF", "IMG.cr3", "IMG.dng", "IMG.x3f", "A7R.ARW", "P.RAF", "x.orf", "x.rw2", "x.pef",
      "notes.txt", "clip.mp4", "archive.zip", "IMG_0001.jpg.bak", "catalog.json", "Makefile", "IMG_0001",
      "", ".", ".jpg", "a.", "photo.heic", "photo.heif", "a.b.jpg",
    ];
    for (const name of names) expect(isSupportedName(name), name).toBe(appIsSupportedName(name));
  });

  it("takes HEIC and HEIF, Sony and Canon's .hif included", () => {
    expect(isSupportedName("IMG_0001.HEIC")).toBe(true);
    expect(isSupportedName("a.heif")).toBe(true);
    expect(isSupportedName("C0001.HIF")).toBe(true);
  });

  it("refuses formats no decoder reads", () => {
    expect(isSupportedName("a.jxl")).toBe(false);
    expect(isSupportedName("a.gif")).toBe(false);
  });

  it("reaches no DOM module", () => {
    for (const entry of ["catalog/photo-names.ts", "project/entry-names.ts"]) {
      expect(reach(path.join(SRC, entry)).filter((f) => BANNED.test(f)), entry).toEqual([]);
    }
  });
});

describe("isEntryName", () => {
  it("takes plain names", () => {
    for (const name of ["a.jpg", "IMG 1.nef", "console.jpg", "a".repeat(200), "x-y_z (1).dng"]) {
      expect(isEntryName(name), name).toBe(true);
    }
  });

  it("refuses names the scan skips or a platform can't keep", () => {
    const bad = [
      "", ".", "..", ".hidden.jpg", ".safelight", "a/b.jpg", "a\\b.jpg", "C:x.jpg", "bad?.jpg", "a<b", 'a"b', "a|b", "a*b",
      "trail.", "trail ", "con.jpg", "NUL", "Com1.nef", "lpt9.png", "aux.tar.jpg", "prn.JPG", "a\u0001b", "a".repeat(201),
    ];
    for (const name of bad) expect(isEntryName(name), JSON.stringify(name)).toBe(false);
  });
});

describe("folderSegments", () => {
  it("reads the project root as no segments", () => {
    expect(folderSegments(undefined)).toEqual([]);
    expect(folderSegments("")).toEqual([]);
  });

  it("splits a folder of plain names", () => {
    expect(folderSegments("a/b c/d")).toEqual(["a", "b c", "d"]);
    expect(folderSegments("com10")).toEqual(["com10"]);
  });

  it("refuses a folder that leaves the project or the scan skips", () => {
    const bad = ["..", "a/../..", "/etc", "C:/x", "a\\b", ".safelight", "a//b", ".git", "a/.b", "$RECYCLE.BIN",
      "System Volume Information", "x/Recycler", "CON", "a/prn", "nul.d", "Com9"];
    for (const folder of bad) expect(folderSegments(folder), folder).toBeNull();
    expect(folderSegments(3)).toBeNull();
  });
});
