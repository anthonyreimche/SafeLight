import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileGlob, expandGlob, hasGlob, splitGlob } from "./glob";

describe("compileGlob", () => {
  it("keeps * and ? inside one folder", () => {
    const g = compileGlob("*.ARW", false);
    expect(g.test("a.ARW")).toBe(true);
    expect(g.test("sub/a.ARW")).toBe(false);
    expect(compileGlob("IMG_?.ARW", false).test("IMG_1.ARW")).toBe(true);
    expect(compileGlob("IMG_?.ARW", false).test("IMG_12.ARW")).toBe(false);
  });

  it("lets ** cross folders, including none", () => {
    const g = compileGlob("2026-11/**/*.RAF", false);
    expect(g.test("2026-11/a.RAF")).toBe(true);
    expect(g.test("2026-11/x/y/a.RAF")).toBe(true);
    expect(g.test("2026-10/a.RAF")).toBe(false);
    expect(compileGlob("**", false).test("a/b/c.raf")).toBe(true);
  });

  it("picks one of a brace group, and treats a lone brace as text", () => {
    const g = compileGlob("*.{ARW,raf}", true);
    expect(g.test("a.arw")).toBe(true);
    expect(g.test("a.RAF")).toBe(true);
    expect(g.test("a.jpg")).toBe(false);
    expect(compileGlob("a{b.txt", false).test("a{b.txt")).toBe(true);
  });

  it("escapes regex characters", () => {
    expect(compileGlob("a.b(1)*", false).test("a.b(1)x")).toBe(true);
    expect(compileGlob("a.b", false).test("aXb")).toBe(false);
  });

  it("is case-sensitive only when asked", () => {
    expect(compileGlob("*.arw", false).test("A.ARW")).toBe(false);
    expect(compileGlob("*.arw", true).test("A.ARW")).toBe(true);
  });
});

describe("splitGlob", () => {
  it("splits at the first wildcard segment", () => {
    expect(splitGlob("2026-11/**/*.RAF", "linux")).toEqual({ base: "2026-11", rest: "**/*.RAF" });
    expect(splitGlob("*.ARW", "linux")).toEqual({ base: ".", rest: "*.ARW" });
    expect(splitGlob("/photos/*.ARW", "linux")).toEqual({ base: "/photos", rest: "*.ARW" });
    expect(splitGlob("/*.ARW", "linux")).toEqual({ base: "/", rest: "*.ARW" });
  });

  it("reads backslashes as separators on Windows only", () => {
    expect(splitGlob("C:\\shoot\\*.ARW", "win32")).toEqual({ base: "C:/shoot", rest: "*.ARW" });
    expect(splitGlob("C:\\*.ARW", "win32")).toEqual({ base: "C:/", rest: "*.ARW" });
    expect(splitGlob("a\\b*", "linux")).toEqual({ base: ".", rest: "a\\b*" });
  });
});

describe("hasGlob", () => {
  it("spots wildcards", () => {
    expect(hasGlob("*.ARW")).toBe(true);
    expect(hasGlob("a?.arw")).toBe(true);
    expect(hasGlob("IMG_4021.ARW")).toBe(false);
  });
});

describe("expandGlob", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "slu-glob-"));
    await mkdir(join(dir, "day1", "deep"), { recursive: true });
    await mkdir(join(dir, ".safelight"));
    for (const f of ["a.ARW", "b.arw", "c.jpg", "day1/d.ARW", "day1/deep/e.ARW", ".safelight/x.ARW"]) {
      await writeFile(join(dir, f), "x");
    }
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const names = (paths: string[]) => paths.map((p) => p.slice(dir.length + 1).replace(/\\/g, "/"));

  it("matches one folder only without **", async () => {
    expect(names(await expandGlob("*.ARW", dir, "linux"))).toEqual(["a.ARW"]);
  });

  it("ignores case on Windows and macOS", async () => {
    expect(names(await expandGlob("*.ARW", dir, "win32"))).toEqual(["a.ARW", "b.arw"]);
    expect(names(await expandGlob("*.ARW", dir, "darwin"))).toEqual(["a.ARW", "b.arw"]);
  });

  it("goes through subfolders with ** and skips dot folders", async () => {
    expect(names(await expandGlob("**/*.ARW", dir, "linux"))).toEqual(["a.ARW", "day1/d.ARW", "day1/deep/e.ARW"]);
  });

  it("starts from the static folder and takes absolute patterns", async () => {
    expect(names(await expandGlob("day1/*.ARW", dir, "linux"))).toEqual(["day1/d.ARW"]);
    expect(names(await expandGlob(join(dir, "day1", "**", "*.ARW"), "/elsewhere", process.platform))).toEqual(["day1/d.ARW", "day1/deep/e.ARW"]);
  });

  it("finds nothing in a folder that doesn't exist", async () => {
    expect(await expandGlob("nope/*.ARW", dir, "linux")).toEqual([]);
  });
});
