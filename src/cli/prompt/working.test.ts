import { describe, expect, it } from "vitest";
import { currentPath, holdsFolder, openSet, stepSet, withoutPhotos, workingInfo } from "./working";

const SET = { paths: ["/p/a.NEF", "/p/b.NEF", "/p/Day 2/c.NEF"], index: 0, root: "/p" };

describe("working set", () => {
  it("opens on the first photo; nothing opens no set", () => {
    expect(openSet(["/p/a.NEF", "/p/b.NEF"], "/p")).toEqual({ paths: ["/p/a.NEF", "/p/b.NEF"], index: 0, root: "/p" });
    expect(openSet([], "/p")).toBeNull();
  });

  it("steps through the set and stops at either end", () => {
    const one = stepSet(SET, 1);
    expect(one).toEqual({ set: { ...SET, index: 1 }, moved: 1 });
    expect(currentPath(one.set)).toBe("/p/b.NEF");
    expect(stepSet(SET, 5)).toEqual({ set: { ...SET, index: 2 }, moved: 2 });
    expect(stepSet(SET, -1)).toEqual({ set: SET, moved: 0 });
    expect(stepSet({ ...SET, index: 2 }, 1).moved).toBe(0);
  });

  it("drops photos that left, keeping the cursor on its photo or the next one", () => {
    expect(withoutPhotos({ ...SET, index: 2 }, (abs) => abs === "/p/a.NEF")).toEqual({ ...SET, paths: ["/p/b.NEF", "/p/Day 2/c.NEF"], index: 1 });
    expect(withoutPhotos({ ...SET, index: 1 }, (abs) => abs === "/p/b.NEF")).toEqual({ ...SET, paths: ["/p/a.NEF", "/p/Day 2/c.NEF"], index: 1 });
    expect(withoutPhotos({ ...SET, index: 2 }, (abs) => abs !== "/p/a.NEF")).toEqual({ ...SET, paths: ["/p/a.NEF"], index: 0 });
    expect(withoutPhotos(SET, () => true)).toBeNull();
  });

  it("knows when a folder is outside the set's project", () => {
    expect(holdsFolder(SET, "/p", "linux")).toBe(true);
    expect(holdsFolder(SET, "/p/Day 2", "linux")).toBe(true);
    expect(holdsFolder(SET, "/", "linux")).toBe(false);
    expect(holdsFolder(SET, "/q", "linux")).toBe(false);
    expect(holdsFolder(SET, "/p2", "linux")).toBe(false);
    expect(holdsFolder({ paths: ["C:\\P\\a.NEF"], index: 0, root: "C:\\P" }, "c:\\p\\day", "win32")).toBe(true);
  });

  it("gives the context each photo from the prompt's folder", () => {
    expect(workingInfo({ ...SET, index: 1 }, "/p/Day 2", "linux")).toEqual({ rels: ["../a.NEF", "../b.NEF", "c.NEF"], at: 1 });
    expect(workingInfo({ paths: ["C:\\P\\Day 2\\c.NEF"], index: 0, root: "C:\\P" }, "C:\\P", "win32")).toEqual({ rels: ["Day 2/c.NEF"], at: 0 });
  });
});
