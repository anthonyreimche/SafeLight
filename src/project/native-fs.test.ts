// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NativeFsBridge } from "@/extensions/types";
import { MemoryFs, fsaDirectoryHandle } from "./memory-fs.test-support";

const h = vi.hoisted(() => ({ fs: null as NativeFsBridge | null }));

vi.mock("@/native/privileged", () => ({ privilegedFs: () => h.fs }));

import {
  isNativeFS,
  nativeDirectoryHandle,
  nativeFs,
  nativePathOf,
  pickNativeDirectory,
  revealNativePath,
} from "./native-fs";

/** Both path shapes the app runs on: a Windows drive root and a POSIX mount. */
const ROOTS = [
  { label: "windows", root: "D:\\Photos", base: "Photos", child: "2024" },
  { label: "posix", root: "/home/u/photos", base: "photos", child: "2024" },
] as const;

/** MemoryFs keys every entry with forward slashes, whatever shape went in. */
const key = (p: string) => p.replace(/\\/g, "/");

function mount(...dirs: string[]): MemoryFs {
  const fs = new MemoryFs(...dirs);
  h.fs = fs;
  return fs;
}

async function textOf(handle: FileSystemFileHandle): Promise<string> {
  return (await handle.getFile()).text();
}

beforeEach(() => {
  h.fs = null;
});

describe("native-fs bridge detection", () => {
  it("reports no native fs in the plain-browser build", () => {
    expect(isNativeFS()).toBe(false);
    expect(nativeFs()).toBeNull();
    expect(() => nativeDirectoryHandle("/anywhere")).toThrow(/native fs bridge/i);
  });

  it("picking a directory and revealing a path degrade quietly without a bridge", async () => {
    await expect(pickNativeDirectory()).resolves.toBeNull();
    await expect(revealNativePath("/anywhere")).resolves.toBe(false);
  });

  it("reveals an existing path and reports failure for a missing one", async () => {
    const fs = mount("/home/u/photos");
    fs.put("/home/u/photos/a.jpg", "x");

    await expect(revealNativePath("/home/u/photos/a.jpg")).resolves.toBe(true);
    await expect(revealNativePath("/home/u/photos/gone.jpg")).resolves.toBe(false);
    expect(fs.revealed).toEqual(["/home/u/photos/a.jpg", "/home/u/photos/gone.jpg"]);
  });

  it("returns the picked directory path", async () => {
    mount().picked = "D:\\Photos";
    await expect(pickNativeDirectory()).resolves.toBe("D:\\Photos");
  });
});

describe("nativePathOf", () => {
  it("recovers the absolute path from a native handle", () => {
    mount("/home/u/photos");
    expect(nativePathOf(nativeDirectoryHandle("/home/u/photos"))).toBe("/home/u/photos");
  });

  it("returns null for anything that isn't a native handle", () => {
    const fs = mount("/home/u/photos");
    expect(nativePathOf(null)).toBeNull();
    expect(nativePathOf(undefined)).toBeNull();
    expect(nativePathOf({ kind: "directory", name: "photos" })).toBeNull();
    expect(nativePathOf(fsaDirectoryHandle(fs, "/home/u/photos"))).toBeNull();
  });
});

describe.each(ROOTS)("native handles ($label paths)", ({ root, base, child }) => {
  it("names a handle after its last path segment, ignoring a trailing separator", () => {
    mount(root);
    expect(nativeDirectoryHandle(root).name).toBe(base);
    expect(nativeDirectoryHandle(`${root}/${child}/`).name).toBe(child);
  });

  it("round-trips a file through createWritable and getFile", async () => {
    const fs = mount(root);
    const dir = nativeDirectoryHandle(root);

    const fh = await dir.getFileHandle("catalog.json", { create: true });
    const w = await fh.createWritable();
    await w.write('{"version":');
    await w.write("1}");
    await w.close();

    expect(fs.text(`${root}/catalog.json`)).toBe('{"version":1}');
    expect(await textOf(fh)).toBe('{"version":1}');
    expect(nativePathOf(fh)).toBe(`${root}/catalog.json`);
    expect(fh.name).toBe("catalog.json");
  });

  it("stamps the file's mtime and extension-derived MIME type onto getFile()", async () => {
    const fs = mount(root);
    fs.put(`${root}/IMG_0001.JPG`, "jpeg-bytes");
    const { mtimeMs } = await fs.read(`${root}/IMG_0001.JPG`);

    const file = await (await nativeDirectoryHandle(root).getFileHandle("IMG_0001.JPG")).getFile();

    expect(file.name).toBe("IMG_0001.JPG");
    expect(file.type).toBe("image/jpeg");
    expect(file.lastModified).toBe(mtimeMs);
    expect(await file.text()).toBe("jpeg-bytes");
  });

  it("derives the MIME type from the file name, not from a dot in its folder", async () => {
    // A folder like "albums.jpg" must not make every extensionless file inside
    // it claim to be a JPEG — the type comes from the entry, not the path.
    const fs = mount(`${root}/albums.jpg`);
    fs.put(`${root}/albums.jpg/NOTES`, "not an image");

    const file = await (
      await nativeDirectoryHandle(`${root}/albums.jpg`).getFileHandle("NOTES")
    ).getFile();

    expect(file.type).toBe("");
  });

  it("rejects a read of a file that isn't there", async () => {
    mount(root);
    const fh = await nativeDirectoryHandle(root).getFileHandle("missing.json");
    await expect(fh.getFile()).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates a subdirectory only when asked to", async () => {
    const fs = mount(root);

    await nativeDirectoryHandle(root).getDirectoryHandle("previews");
    expect(fs.has(`${root}/previews`)).toBe(false);

    await nativeDirectoryHandle(root).getDirectoryHandle("previews", { create: true });
    expect(fs.has(`${root}/previews`)).toBe(true);
  });

  it("propagates a read-only failure from creating a subdirectory", async () => {
    // The signal resolveWorkingDir keys its redirect off: a frozen card must
    // reject mkdir rather than hand back a handle that silently drops writes.
    mount(root).freeze(root);
    await expect(
      nativeDirectoryHandle(root).getDirectoryHandle(".safelight", { create: true }),
    ).rejects.toMatchObject({ code: "EROFS" });
  });

  it("propagates a read-only failure from a write, at close", async () => {
    mount(root).freeze(root);
    const w = await (await nativeDirectoryHandle(root).getFileHandle("x.json")).createWritable();
    await w.write("{}");
    await expect(w.close()).rejects.toMatchObject({ code: "EROFS" });
  });

  it("enumerates entries with their kinds, and keys with their names", async () => {
    const fs = mount(root);
    fs.put(`${root}/a.jpg`, "a").put(`${root}/${child}/b.jpg`, "b").mkdirp(`${root}/empty`);

    const seen: { name: string; kind: string }[] = [];
    for await (const entry of nativeDirectoryHandle(root).values())
      seen.push({ name: entry.name, kind: entry.kind });
    expect(seen).toEqual([
      { name: child, kind: "directory" },
      { name: "a.jpg", kind: "file" },
      { name: "empty", kind: "directory" },
    ]);

    const keys: string[] = [];
    const dir = nativeDirectoryHandle(root) as unknown as { keys(): AsyncIterable<string> };
    for await (const name of dir.keys()) keys.push(name);
    expect(keys).toEqual([child, "a.jpg", "empty"]);
  });

  it("removes an entry, subtree and all", async () => {
    const fs = mount(root);
    fs.put(`${root}/${child}/b.jpg`, "b").put(`${root}/keep.jpg`, "k");

    await nativeDirectoryHandle(root).removeEntry(child, { recursive: true });

    expect(fs.tree()).toEqual([key(`${root}/keep.jpg`)]);
  });
});

describe("native handle sandboxing", () => {
  // A native handle is reachable from the catalog store, so an extension holding
  // the project folder's directoryHandle must not be able to walk out of it.
  const escapes = ["..", ".", "", "../secret", "a/b", "a\\b", "/etc/passwd", "D:\\other"];

  it.each(escapes)("refuses %j as an entry name", async (name) => {
    mount("/home/u/photos");
    const dir = nativeDirectoryHandle("/home/u/photos");
    await expect(dir.getFileHandle(name)).rejects.toBeInstanceOf(TypeError);
    await expect(dir.getDirectoryHandle(name)).rejects.toBeInstanceOf(TypeError);
    await expect(dir.removeEntry(name)).rejects.toBeInstanceOf(TypeError);
  });

  it("leaves the filesystem untouched when a traversal is refused", async () => {
    const fs = mount("/home/u/photos", "/home/u/secret");
    fs.put("/home/u/secret/keys.txt", "top secret");

    await expect(
      nativeDirectoryHandle("/home/u/photos").removeEntry("../secret"),
    ).rejects.toBeInstanceOf(TypeError);

    expect(fs.text("/home/u/secret/keys.txt")).toBe("top secret");
  });
});
