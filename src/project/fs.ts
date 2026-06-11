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
