// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Native (Electron) file access.
//
// Path-backed objects that implement the slice of the File System Access API
// the app actually uses (see scan.ts, project-storage.ts, fs.ts, raw-cache.ts,
// load-image.ts), backed by an IPC fs bridge in the Electron main process.
//
// Why: FSA directory handles persist in IndexedDB but their permission resets
// to "prompt" on every cold start, so the browser build needs a click to
// reconnect the originals. Absolute paths don't expire — so in Electron we keep
// the path, rebuild a handle from it on launch, and read immediately with no
// gesture. All the handle-consuming code runs unchanged because these adapters
// quack like the real handles.
//
// Native handles intentionally omit queryPermission/requestPermission, so
// verifyPermission() treats them as readable (its "no permission API → assume
// readable" branch) — exactly what we want for a path we already trust.

import type { NativeFsBridge } from "@/extensions/types";
import photoTypes from "../../electron/photo-types.json";
import { privilegedFs } from "@/native/privileged";

type Bridge = NativeFsBridge;

/** The native fs bridge, or null in the plain-browser build. Privileged and
 *  claimed at boot (src/native/privileged.ts) — not reachable via the page
 *  global, so extension code can't read/write arbitrary absolute paths. */
export function nativeFs(): Bridge | null {
  return privilegedFs();
}

export function isNativeFS(): boolean {
  return !!nativeFs();
}

// Join with forward slashes; Node accepts them on Windows too, and mixing with
// a backslash drive prefix (D:\Photos) is fine.
function join(dir: string, name: string): string {
  return `${dir.replace(/[/\\]+$/, "")}/${name}`;
}

function basename(p: string): string {
  return p.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || p;
}

// A directory-handle entry name must be a single path segment — the real File
// System Access API rejects names containing a slash. Enforcing it here also
// confines anyone holding a native handle (e.g. an extension that pulled the
// project folder's directoryHandle out of the catalog store) to that folder:
// "..", "a/b" and absolute paths can't walk out to arbitrary files on disk.
function entryName(name: string): string {
  if (!name || name === "." || name === ".." || /[/\\]/.test(name))
    throw new TypeError(`Invalid file name: ${JSON.stringify(name)}`);
  return name;
}

// Brand: lets the recent-projects store recognise a native handle and pull its
// absolute path back out.
const PATH = Symbol("safelight.nativePath");
/** The size the folder listing gave a native file handle. */
const SIZE = Symbol("safelight.nativeSize");

interface Pathed {
  [PATH]: string;
  [SIZE]?: number;
}

/** Absolute path behind a native handle, or null if it isn't one. */
export function nativePathOf(handle: unknown): string | null {
  return (handle as Partial<Pathed> | null)?.[PATH] ?? null;
}

/** The size in bytes the listing gave a native file handle's file, or undefined
 *  (a browser handle, or a handle not reached through a listing). */
export function nativeSizeOf(handle: unknown): number | undefined {
  return (handle as Partial<Pathed> | null)?.[SIZE];
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ...photoTypes.standard,
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};

function mimeFromName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : (MIME_BY_EXTENSION[name.slice(dot).toLowerCase()] ?? "");
}

function makeFileHandle(fs: Bridge, p: string, size?: number): FileSystemFileHandle {
  const handle = {
    [PATH]: p,
    [SIZE]: size,
    kind: "file" as const,
    name: basename(p),
    async getFile(): Promise<File> {
      const { data, mtimeMs } = await fs.read(p);
      // fs.read returns a non-shared Uint8Array; cast past TS's generic
      // ArrayBufferLike (which can't prove it isn't a SharedArrayBuffer).
      return new File([data as BlobPart], basename(p), {
        type: mimeFromName(basename(p)),
        lastModified: mtimeMs,
      });
    },
    async createWritable() {
      // Accumulate parts (Blob | string | ArrayBuffer | typed array all work as
      // Blob parts), flush once on close. Our writers do a single write+close.
      const parts: BlobPart[] = [];
      const writable = {
        async write(chunk: BlobPart) {
          parts.push(chunk);
        },
        async truncate(_size: number) {},
        async seek(_pos: number) {},
        async abort() {},
        async close() {
          // Text goes to the bridge with no await first: the catalog flush on
          // window close runs in beforeunload, and the send must leave before
          // the page unloads.
          if (parts.every((part): part is string => typeof part === "string")) {
            await fs.write(p, new TextEncoder().encode(parts.join("")));
            return;
          }
          const buf = new Uint8Array(await new Blob(parts).arrayBuffer());
          await fs.write(p, buf);
        },
      };
      return writable as unknown as FileSystemWritableFileStream;
    },
  };
  return handle as unknown as FileSystemFileHandle;
}

/** `root` is the folder the handle tree was opened at, named to each listing so
 *  the bridge leaves out folder links back into it. */
function makeDirHandle(fs: Bridge, p: string, root = p): FileSystemDirectoryHandle {
  const handle = {
    [PATH]: p,
    kind: "directory" as const,
    name: basename(p),
    async getFileHandle(name: string, _opts?: { create?: boolean }) {
      // Lazy: the file is read/written on demand. Missing-file reads reject (the
      // bridge throws ENOENT), which the readJSON/readBlob/cache callers catch.
      return makeFileHandle(fs, join(p, entryName(name)));
    },
    async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
      const child = join(p, entryName(name));
      if (opts?.create) await fs.mkdir(child);
      return makeDirHandle(fs, child, root);
    },
    async removeEntry(name: string, _opts?: { recursive?: boolean }) {
      await fs.remove(join(p, entryName(name)));
    },
    async *values() {
      for (const e of await fs.list(p, root)) {
        yield e.kind === "directory"
          ? makeDirHandle(fs, join(p, e.name), root)
          : makeFileHandle(fs, join(p, e.name), e.size);
      }
    },
    // Used by raw-cache clearRawCache() via a structural cast.
    async *keys() {
      for (const e of await fs.list(p)) yield e.name;
    },
  };
  return handle as unknown as FileSystemDirectoryHandle;
}

/** Part of a file, with what getFile() would say of the whole file. */
export interface FileSlice {
  data: Uint8Array<ArrayBuffer>;
  size: number;
  lastModified: number;
  type: string;
}

/** Bytes [start, end) of a file, clipped to its end, reading no more of it than
 *  that: a range read over the desktop bridge, where getFile() would carry the
 *  whole file across, or a slice of the disk-backed File in the browser build. */
export async function readFileSlice(
  handle: FileSystemFileHandle,
  start: number,
  end: number,
): Promise<FileSlice> {
  const path = nativePathOf(handle);
  const fs = nativeFs();
  if (path !== null && fs) {
    const { data, size, mtimeMs } = await fs.read(path, { start, end });
    return {
      data: new Uint8Array(data),
      size,
      lastModified: mtimeMs,
      type: mimeFromName(handle.name),
    };
  }
  const file = await handle.getFile();
  return {
    data: new Uint8Array(await file.slice(start, end).arrayBuffer()),
    size: file.size,
    lastModified: file.lastModified,
    type: file.type,
  };
}

/** Build a native directory handle for an absolute path. */
export function nativeDirectoryHandle(path: string): FileSystemDirectoryHandle {
  const fs = nativeFs();
  if (!fs) throw new Error("native fs bridge unavailable");
  return makeDirHandle(fs, path);
}

/** Open the native folder picker; returns the chosen absolute path or null. */
export async function pickNativeDirectory(): Promise<string | null> {
  const fs = nativeFs();
  if (!fs) return null;
  return fs.pickDirectory();
}

/** Ask the person for a folder to write into: the native picker on the
 *  desktop, whose handle carries the absolute path, else the File System
 *  Access picker, which remembers its last folder per `id`. Null when they
 *  cancel. */
export async function pickDirectoryHandle(id: string): Promise<FileSystemDirectoryHandle | null> {
  if (isNativeFS()) {
    const path = await pickNativeDirectory();
    return path ? nativeDirectoryHandle(path) : null;
  }
  try {
    return await window.showDirectoryPicker({ mode: "readwrite", id });
  } catch {
    return null;
  }
}

/** Reveal an absolute path in the OS file manager (open a directory, or select
 *  a file in its parent folder). Returns false in the plain-browser build. */
export async function revealNativePath(path: string): Promise<boolean> {
  const fs = nativeFs();
  if (!fs) return false;
  return fs.reveal(path);
}
