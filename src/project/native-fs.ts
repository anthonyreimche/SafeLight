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

type Bridge = NonNullable<NonNullable<Window["safelightNative"]>["fs"]>;

/** The native fs bridge, or null in the plain-browser build. */
export function nativeFs(): Bridge | null {
  return window.safelightNative?.fs ?? null;
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

// Brand: lets saveLastProject/getLastProject recognise a native handle and pull
// its absolute path back out.
const PATH = Symbol("safelight.nativePath");

interface Pathed {
  [PATH]: string;
}

/** Absolute path behind a native handle, or null if it isn't one. */
export function nativePathOf(handle: unknown): string | null {
  return (handle as Partial<Pathed> | null)?.[PATH] ?? null;
}

function mimeFromName(name: string): string {
  const ext = name.toLowerCase().split(".").pop() || "";
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    tif: "image/tiff",
    tiff: "image/tiff",
    bmp: "image/bmp",
  };
  return map[ext] ?? "";
}

function makeFileHandle(fs: Bridge, p: string): FileSystemFileHandle {
  const handle = {
    [PATH]: p,
    kind: "file" as const,
    name: basename(p),
    async getFile(): Promise<File> {
      const { data, mtimeMs } = await fs.read(p);
      return new File([data], basename(p), {
        type: mimeFromName(p),
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
          const buf = new Uint8Array(await new Blob(parts).arrayBuffer());
          await fs.write(p, buf);
        },
      };
      return writable as unknown as FileSystemWritableFileStream;
    },
  };
  return handle as unknown as FileSystemFileHandle;
}

function makeDirHandle(fs: Bridge, p: string): FileSystemDirectoryHandle {
  const handle = {
    [PATH]: p,
    kind: "directory" as const,
    name: basename(p),
    async getFileHandle(name: string, _opts?: { create?: boolean }) {
      // Lazy: the file is read/written on demand. Missing-file reads reject (the
      // bridge throws ENOENT), which the readJSON/readBlob/cache callers catch.
      return makeFileHandle(fs, join(p, name));
    },
    async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
      const child = join(p, name);
      if (opts?.create) await fs.mkdir(child);
      return makeDirHandle(fs, child);
    },
    async removeEntry(name: string, _opts?: { recursive?: boolean }) {
      await fs.remove(join(p, name));
    },
    async *values() {
      for (const e of await fs.list(p)) {
        yield e.kind === "directory"
          ? makeDirHandle(fs, join(p, e.name))
          : makeFileHandle(fs, join(p, e.name));
      }
    },
    // Used by raw-cache clearRawCache() via a structural cast.
    async *keys() {
      for (const e of await fs.list(p)) yield e.name;
    },
  };
  return handle as unknown as FileSystemDirectoryHandle;
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
