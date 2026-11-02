// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeFsBridge } from "@/extensions/types";
import { isSupportedName } from "@/modules/library/import-photos";
import { scanProject } from "./scan";
import { FolderUnavailableError } from "./catalog-errors";
import { FsError, MemoryFs } from "./memory-fs.test-support";
import { nativeDirectoryHandle } from "./native-fs";

const h = vi.hoisted(() => ({ fs: null as NativeFsBridge | null }));

vi.mock("@/native/privileged", () => ({ privilegedFs: () => h.fs }));

afterEach(() => {
  h.fs = null;
});

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
      isSupportedName,
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
      isSupportedName,
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
      isSupportedName,
    );
    expect(files.map((f) => f.path)).toEqual(["a.NEF", "sub/b.jpg"]);
    expect(sidecars).toEqual(
      new Set(["a.NEF.safelight.json", "sub/b.jpg.safelight.json"]),
    );
  });

  describe("a folder that can't be read", () => {
    function locked(name: string, code: string): FakeDir {
      return {
        kind: "directory",
        name,
        async *values() {
          throw Object.assign(new Error(`${code}: permission denied, scandir '${name}'`), { code });
        },
      };
    }

    it.each(["EACCES", "EPERM"])("skips the %s subtree and scans the siblings", async (code) => {
      const { files, tree, unreadable } = await scanProject(
        asRoot(
          dir("root", [
            file("a.jpg"),
            dir("ok", [file("b.jpg"), locked("deep", code)]),
            locked("locked", code),
            dir("z", [file("z1.jpg")]),
          ]),
        ),
        isSupportedName,
      );
      expect(files.map((f) => f.path)).toEqual(["a.jpg", "ok/b.jpg", "z/z1.jpg"]);
      expect(unreadable).toEqual(["ok/deep", "locked"].sort());
      const flagged = (node: typeof tree): string[] => [
        ...(node.unreadable ? [node.path] : []),
        ...node.children.flatMap(flagged),
      ];
      expect(flagged(tree).sort()).toEqual(["locked", "ok/deep"]);
      expect(tree.children.map((c) => c.name)).toEqual(["locked", "ok", "z"]);
    });

    it.each(["$RECYCLE.BIN", "$Recycle.Bin", "System Volume Information", "lost+found", "RECYCLER"])(
      "skips the OS folder %s without walking, listing or reporting it",
      async (name) => {
        const walked = vi.fn();
        const system: FakeDir = {
          kind: "directory",
          name,
          async *values() {
            walked();
            yield file("hidden.jpg");
          },
        };
        const { files, tree, unreadable } = await scanProject(
          asRoot(dir("root", [file("a.jpg"), system, locked("System Volume Information", "EACCES")])),
          isSupportedName,
        );
        expect(walked).not.toHaveBeenCalled();
        expect(files.map((f) => f.path)).toEqual(["a.jpg"]);
        expect(tree.children).toEqual([]);
        expect(unreadable).toEqual([]);
      },
    );

    it("reports nothing unreadable for a clean project", async () => {
      const { unreadable } = await scanProject(asRoot(dir("root", [file("a.jpg")])), isSupportedName);
      expect(unreadable).toEqual([]);
    });

    it("still fails when the project folder itself can't be read", async () => {
      await expect(
        scanProject(asRoot(locked("root", "EACCES")), isSupportedName),
      ).rejects.toMatchObject({ code: "EACCES" });
    });

    it("fails as a folder that can't be reached when the project folder isn't there", async () => {
      const gone: FakeDir = {
        kind: "directory",
        name: "card",
        async *values() {
          throw new DOMException("gone", "NotFoundError");
        },
      };
      await expect(scanProject(asRoot(gone), isSupportedName)).rejects.toBeInstanceOf(
        FolderUnavailableError,
      );
    });

    it.each([
      ["EIO", () => Object.assign(new Error("EIO: i/o error, scandir 'flaky'"), { code: "EIO" })],
      ["NotFoundError", () => new DOMException("gone", "NotFoundError")],
    ])("lists a subfolder failing with %s as unreadable, not as the drive gone", async (_, failure) => {
      const flaky: FakeDir = {
        kind: "directory",
        name: "flaky",
        async *values() {
          throw failure();
        },
      };
      const { files, tree, unreadable } = await scanProject(
        asRoot(dir("root", [file("a.jpg"), flaky, dir("z", [file("z1.jpg")])])),
        isSupportedName,
      );
      expect(files.map((f) => f.path)).toEqual(["a.jpg", "z/z1.jpg"]);
      expect(unreadable).toEqual(["flaky"]);
      expect(tree.children.find((c) => c.name === "flaky")?.unreadable).toBe(true);
    });

    it("still fails on a subfolder error that is neither permission nor reachability", async () => {
      const broken: FakeDir = {
        kind: "directory",
        name: "broken",
        async *values() {
          throw new Error("boom");
        },
      };
      await expect(
        scanProject(asRoot(dir("root", [broken])), isSupportedName),
      ).rejects.toThrow(/boom/);
    });
  });

  it("counts the files it skipped by lower-cased extension, leaving sidecars out", async () => {
    const { skipped } = await scanProject(
      asRoot(
        dir("root", [
          file("a.heic"),
          file("b.jpg"),
          file("c.HEIC"),
          file("README"),
          file("a.heic.safelight.json"),
          dir("sub", [file("d.heif"), file(".hidden.heic")]),
        ]),
      ),
      isSupportedName,
    );
    expect(skipped).toEqual({ ".heic": 2, ".heif": 1, "(none)": 1 });
  });

  describe("over the desktop bridge", () => {
    /** A MemoryFs on which the folders `broken` name are links to nothing: the
     *  bridge lists each as a folder, and listing it fails. */
    class LinkedFs extends MemoryFs {
      private readonly broken: string[];

      constructor(root: string, broken: string[] = []) {
        super(root);
        this.broken = broken;
      }

      override async list(path: string) {
        if (this.broken.includes(path)) throw new FsError("ENOENT", "scandir", path);
        const listed = await super.list(path);
        const here = this.broken.filter((b) => b.slice(0, b.lastIndexOf("/")) === path);
        return [...listed, ...here.map((b) => ({ name: b.slice(b.lastIndexOf("/") + 1), kind: "directory" as const }))];
      }
    }

    const scanNative = (fs: MemoryFs) => {
      h.fs = fs;
      return scanProject(nativeDirectoryHandle("/card"), isSupportedName);
    };

    it("names the project folder to every listing, so links into it are left out", async () => {
      const fs = new LinkedFs("/card").put("/card/DCIM/100/a.jpg", "1");
      const list = vi.spyOn(fs, "list");
      await scanNative(fs);
      expect(list.mock.calls).toEqual([
        ["/card", "/card"],
        ["/card/DCIM", "/card"],
        ["/card/DCIM/100", "/card"],
      ]);
    });

    it("takes each file's size from the listing", async () => {
      const { files } = await scanNative(new LinkedFs("/card").put("/card/DCIM/a.jpg", "12345"));
      expect(files.map((f) => [f.path, f.size])).toEqual([["DCIM/a.jpg", 5]]);
    });

    it("walks a linked folder the listing gives as a folder", async () => {
      // The bridge lists a junction or symlink as the folder it points to.
      const fs = new LinkedFs("/card").put("/card/linked/b.jpg", "123");
      const { files, unreadable } = await scanNative(fs);
      expect(files.map((f) => f.path)).toEqual(["linked/b.jpg"]);
      expect(unreadable).toEqual([]);
    });

    it("marks a link to nothing unreadable rather than taking it for an emptied folder", async () => {
      const fs = new LinkedFs("/card", ["/card/gone"]).put("/card/a.jpg", "1");
      const { files, tree, unreadable } = await scanNative(fs);
      expect(files.map((f) => f.path)).toEqual(["a.jpg"]);
      expect(unreadable).toEqual(["gone"]);
      expect(tree.children.find((c) => c.name === "gone")?.unreadable).toBe(true);
    });
  });

  it("collects the files the predicate it is handed accepts", async () => {
    const { files, tree } = await scanProject(
      asRoot(dir("root", [file("a.NEF"), file("notes.txt"), dir("sub", [file("todo.txt")])])),
      (name) => name.endsWith(".txt"),
    );
    expect(files.map((f) => f.path)).toEqual(["notes.txt", "sub/todo.txt"]);
    expect(tree.count).toBe(1);
  });
});
