// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it } from "vitest";
import { scanProject } from "./scan";

interface FakeFile {
  kind: "file";
  name: string;
}

interface FakeDir {
  kind: "directory";
  name: string;
  values(): AsyncIterable<FakeFile | FakeDir>;
}

function file(name: string): FakeFile {
  return { kind: "file", name };
}

function dir(name: string, entries: (FakeFile | FakeDir)[]): FakeDir {
  return {
    kind: "directory",
    name,
    async *values() {
      yield* entries;
    },
  };
}

const asRoot = (d: FakeDir) => d as unknown as FileSystemDirectoryHandle;

describe("scanProject", () => {
  it("collects supported images with posix-relative paths, skipping dot-folders", async () => {
    const { files, tree } = await scanProject(
      asRoot(
        dir("root", [
          file("a.NEF"),
          file("notes.txt"),
          dir(".safelight", [file("catalog.json")]),
          dir("sub", [file("b.jpg")]),
        ]),
      ),
    );
    expect(files.map((f) => f.path)).toEqual(["a.NEF", "sub/b.jpg"]);
    expect(tree.count).toBe(1);
    expect(tree.children.map((c) => c.name)).toEqual(["sub"]);
  });

  it("keeps depth-first file order deterministic across sibling folders", async () => {
    const { files } = await scanProject(
      asRoot(
        dir("root", [
          file("a.NEF"),
          dir("z", [file("z1.jpg")]),
          dir("b", [file("b1.jpg"), dir("bb", [file("bb1.jpg")])]),
          file("c.jpg"),
        ]),
      ),
    );
    expect(files.map((f) => f.path)).toEqual([
      "a.NEF",
      "z/z1.jpg",
      "b/b1.jpg",
      "b/bb/bb1.jpg",
      "c.jpg",
    ]);
  });

  it("records sidecar files so the open only probes ones that exist", async () => {
    const { files, sidecars } = await scanProject(
      asRoot(
        dir("root", [
          file("a.NEF"),
          file("a.NEF.safelight.json"),
          dir("sub", [file("b.jpg"), file("b.jpg.safelight.json")]),
        ]),
      ),
    );
    expect(files.map((f) => f.path)).toEqual(["a.NEF", "sub/b.jpg"]);
    expect(sidecars).toEqual(
      new Set(["a.NEF.safelight.json", "sub/b.jpg.safelight.json"]),
    );
  });
});
