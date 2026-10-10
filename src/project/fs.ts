// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Small File System Access helpers for working inside the project's
// .safelight/ directory.

export async function readJSON<T>(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<T | null> {
  try {
    const fh = await dir.getFileHandle(name);
    const file = await fh.getFile();
    return JSON.parse(await file.text()) as T;
  } catch {
    return null;
  }
}

/** What reading a JSON file that should hold an object found. `bytes` are the
 *  file as read, so a damaged one can be kept exactly as it was. */
export type JSONFileRead =
  | { kind: "missing" }
  | { kind: "ok"; value: Record<string, unknown>; bytes: Uint8Array<ArrayBuffer> }
  | { kind: "corrupt"; bytes: Uint8Array<ArrayBuffer> }
  | { kind: "unreadable"; error: unknown };

/** Read a JSON file that should hold an object, telling apart the four outcomes
 *  readJSON makes null: no such file; an object; a file that is empty, cut
 *  short, not JSON, or JSON that isn't an object; and a file that couldn't be
 *  read at all (another program holds it: EBUSY, EPERM, NotReadableError). */
export async function readJSONFile(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<JSONFileRead> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    const file = await (await dir.getFileHandle(name)).getFile();
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (error) {
    return isNotFound(error) ? { kind: "missing" } : { kind: "unreadable", error };
  }
  const value = parseJSONObject(bytes);
  return value ? { kind: "ok", value, bytes } : { kind: "corrupt", bytes };
}

/** The object a JSON file's bytes hold, or null when they hold none: empty, cut
 *  short, not JSON, or JSON that isn't an object. */
export function parseJSONObject(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

/** Whether a read failed because the file isn't there. The desktop bridge loses
 *  an error's `code` on its way to the page, so its ENOENT survives only in the
 *  message, in Node's "ENOENT: no such file…" form; the path the message also
 *  holds may contain the word itself. The browser throws a NotFoundError. */
export function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("name" in error && error.name === "NotFoundError") return true;
  const message = "message" in error ? error.message : undefined;
  return typeof message === "string" && /\bENOENT:/.test(message);
}

/** The time, for a file name: ISO 8601 with its `:` and `.` as `-`, as the
 *  copies of catalogs kept beside catalog.json are named. */
export function fileTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function writeJSON(
  dir: FileSystemDirectoryHandle,
  name: string,
  value: unknown,
): Promise<void> {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify(value));
  await w.close();
}

export async function readBlob(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<Blob | null> {
  try {
    const fh = await dir.getFileHandle(name);
    return await fh.getFile();
  } catch {
    return null;
  }
}

/** Read a file, or null when it isn't there. A read that fails otherwise (another
 *  program holds the file) throws, so a caller can tell the two apart. */
export async function readBlobIfThere(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<Blob | null> {
  try {
    return await (await dir.getFileHandle(name)).getFile();
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function writeBlob(
  dir: FileSystemDirectoryHandle,
  name: string,
  blob: Blob,
): Promise<void> {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(blob);
  await w.close();
}

export async function removeEntry(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<void> {
  try {
    await dir.removeEntry(name);
  } catch {}
}

/** Run `fn` over `items` with bounded concurrency (keeps big projects snappy
 *  without hammering the disk or decoding 500 thumbnails at once). */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    },
  );
  await Promise.all(workers);
  return out;
}
