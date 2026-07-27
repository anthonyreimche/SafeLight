// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Test-only support for the project I/O tests: one in-memory filesystem, driven
// through either adapter the app ships — the Electron `NativeFsBridge` or
// browser File System Access handles — so the same tree can be exercised from
// both builds and compared byte for byte. Not imported by production code.

import type { NativeFsBridge } from "@/extensions/types";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Absolute paths are keyed with forward slashes and no trailing separator, so
 *  `D:\Photos\a`, `D:/Photos/a` and the mixed `D:\Photos/a` that folder-ops and
 *  native-fs build all name the same entry. */
function norm(p: string): string {
  const s = p.replace(/[/\\]+/g, "/");
  return s.length > 1 && s.endsWith("/") ? s.slice(0, -1) : s;
}

function parentOf(p: string): string {
  const i = p.lastIndexOf("/");
  if (i < 0) return "";
  return i === 0 ? "/" : p.slice(0, i);
}

function baseOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

function under(prefix: string, p: string): boolean {
  return p === prefix || p.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
}

/** Carries an errno the way Node's fs rejections do, so tests can assert the
 *  failure mode (ENOENT vs EROFS) rather than a message substring. */
export class FsError extends Error {
  readonly code: string;
  constructor(code: string, op: string, path: string) {
    super(`${code}: ${op} '${path}'`);
    this.name = "FsError";
    this.code = code;
  }
}

/** Real FSA handles reject a path segment that isn't a single name; both the
 *  native adapter (native-fs.entryName) and this fake enforce it, so a test
 *  can't pass a traversal through one build that the other would refuse. */
function segment(name: string): string {
  if (!name || name === "." || name === ".." || /[/\\]/.test(name))
    throw new TypeError(`Invalid file name: ${JSON.stringify(name)}`);
  return name;
}

function notFound(name: string): Error {
  const e = new Error(`A requested file or directory could not be found: ${name}`);
  e.name = "NotFoundError";
  return e;
}

export interface MemoryStat {
  data: Uint8Array;
  mtimeMs: number;
}

/** In-memory filesystem implementing the full native bridge contract. Writes
 *  bump a logical clock so mtime ordering is deterministic. */
export class MemoryFs implements NativeFsBridge {
  private readonly files = new Map<string, MemoryStat>();
  private readonly dirs = new Set<string>();
  private readonly frozen: string[] = [];
  private clock = 1;

  /** Paths handed to reveal(), in call order. */
  readonly revealed: string[] = [];
  /** What pickDirectory() resolves to. */
  picked: string | null = null;

  constructor(...dirs: string[]) {
    for (const d of dirs) this.mkdirp(d);
  }

  // ── test-facing (synchronous) ──────────────────────────────────────────────

  mkdirp(path: string): this {
    let cur = norm(path);
    while (cur && !this.dirs.has(cur)) {
      this.dirs.add(cur);
      cur = parentOf(cur);
    }
    return this;
  }

  put(path: string, text: string): this {
    const n = norm(path);
    this.mkdirp(parentOf(n));
    this.files.set(n, { data: enc.encode(text), mtimeMs: this.clock++ });
    return this;
  }

  text(path: string): string | null {
    const f = this.files.get(norm(path));
    return f ? dec.decode(f.data) : null;
  }

  bytes(path: string): Uint8Array | null {
    return this.files.get(norm(path))?.data ?? null;
  }

  has(path: string): boolean {
    const n = norm(path);
    return this.files.has(n) || this.dirs.has(n);
  }

  /** Every file path under `prefix` (default: the whole store), sorted — for
   *  whole-tree assertions like "nothing was written into the project folder". */
  tree(prefix = ""): string[] {
    const n = prefix ? norm(prefix) : "";
    return [...this.files.keys()].filter((p) => !n || under(n, p)).sort();
  }

  /** Mount everything under `prefix` read-only (a memory card). */
  freeze(prefix: string): this {
    this.frozen.push(norm(prefix));
    return this;
  }

  private guard(op: string, path: string): void {
    const n = norm(path);
    if (this.frozen.some((f) => under(f, n))) throw new FsError("EROFS", op, path);
  }

  // ── NativeFsBridge ─────────────────────────────────────────────────────────

  async read(path: string): Promise<{ data: Uint8Array; mtimeMs: number; size: number }> {
    const f = this.files.get(norm(path));
    if (!f) throw new FsError("ENOENT", "open", path);
    return { data: f.data, mtimeMs: f.mtimeMs, size: f.data.length };
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    this.guard("open", path);
    const n = norm(path);
    this.mkdirp(parentOf(n)); // main.cjs fs:write creates the parent chain
    this.files.set(n, { data: new Uint8Array(data), mtimeMs: this.clock++ });
  }

  async list(path: string): Promise<{ name: string; kind: "file" | "directory" }[]> {
    const n = norm(path);
    if (!this.dirs.has(n)) throw new FsError("ENOENT", "scandir", path);
    const kids = new Map<string, "file" | "directory">();
    for (const f of this.files.keys()) if (parentOf(f) === n) kids.set(baseOf(f), "file");
    for (const d of this.dirs)
      if (d !== n && parentOf(d) === n) kids.set(baseOf(d), "directory");
    return [...kids]
      .map(([name, kind]) => ({ name, kind }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async mkdir(path: string): Promise<void> {
    this.guard("mkdir", path);
    this.mkdirp(path);
  }

  async remove(path: string): Promise<void> {
    this.guard("unlink", path);
    const n = norm(path);
    for (const f of [...this.files.keys()]) if (under(n, f)) this.files.delete(f);
    for (const d of [...this.dirs]) if (under(n, d)) this.dirs.delete(d);
  }

  async move(src: string, dest: string): Promise<void> {
    this.guard("rename", src);
    this.guard("rename", dest);
    const s = norm(src);
    const d = norm(dest);
    if (!this.has(s)) throw new FsError("ENOENT", "rename", src);
    this.mkdirp(parentOf(d));
    // fs.rename semantics: an existing destination file is silently replaced.
    for (const f of [...this.files.keys()])
      if (under(s, f)) {
        const stat = this.files.get(f)!;
        this.files.delete(f);
        this.files.set(d + f.slice(s.length), stat);
      }
    for (const x of [...this.dirs])
      if (under(s, x)) {
        this.dirs.delete(x);
        this.dirs.add(d + x.slice(s.length));
      }
  }

  async exists(path: string): Promise<boolean> {
    return this.has(path);
  }

  async pickDirectory(): Promise<string | null> {
    return this.picked;
  }

  async reveal(path: string): Promise<boolean> {
    this.revealed.push(path);
    return this.has(path);
  }
}

/** File System Access handles over a MemoryFs — the browser build's view of the
 *  same tree. Deliberately carries no native path brand, so code that
 *  feature-detects via nativePathOf() takes its FSA branch. */
export function fsaDirectoryHandle(
  fs: MemoryFs,
  dirPath: string,
): FileSystemDirectoryHandle {
  const p = norm(dirPath);

  const fileHandle = (childPath: string): FileSystemFileHandle => {
    const handle = {
      kind: "file" as const,
      name: baseOf(childPath),
      async getFile(): Promise<File> {
        const { data, mtimeMs } = await fs.read(childPath);
        return new File([data as BlobPart], baseOf(childPath), { lastModified: mtimeMs });
      },
      async createWritable() {
        const parts: BlobPart[] = [];
        const writable = {
          async write(chunk: BlobPart) {
            parts.push(chunk);
          },
          async close() {
            await fs.write(childPath, new Uint8Array(await new Blob(parts).arrayBuffer()));
          },
        };
        return writable as unknown as FileSystemWritableFileStream;
      },
    };
    return handle as unknown as FileSystemFileHandle;
  };

  const handle = {
    kind: "directory" as const,
    name: baseOf(p) || p,
    async getFileHandle(name: string, opts?: { create?: boolean }) {
      const child = `${p}/${segment(name)}`;
      if (!(await fs.exists(child))) {
        if (!opts?.create) throw notFound(name);
        await fs.write(child, new Uint8Array());
      }
      return fileHandle(child);
    },
    async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
      const child = `${p}/${segment(name)}`;
      if (opts?.create) await fs.mkdir(child);
      else if (!(await fs.exists(child))) throw notFound(name);
      return fsaDirectoryHandle(fs, child);
    },
    async removeEntry(name: string, _opts?: { recursive?: boolean }) {
      const child = `${p}/${segment(name)}`;
      if (!(await fs.exists(child))) throw notFound(name);
      await fs.remove(child);
    },
    async *values() {
      for (const e of await fs.list(p))
        yield e.kind === "directory"
          ? fsaDirectoryHandle(fs, `${p}/${e.name}`)
          : fileHandle(`${p}/${e.name}`);
    },
    async *keys() {
      for (const e of await fs.list(p)) yield e.name;
    },
  };
  return handle as unknown as FileSystemDirectoryHandle;
}
