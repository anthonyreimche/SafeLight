// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Opaque per-photo blobs (e.g. an extension's warp displacement field), stored
// as individual files under .safelight/blobs/ so a multi-hundred-KB payload never
// enters the whole-file catalog.json rewrite.

import { listNames, readBlob, removeEntry, safeName, writeBlob } from "./fs";

function blobName(photoId: string, key: string): string {
  return `${safeName(photoId)}.${safeName(key)}.bin`;
}

export class PhotoBlobs {
  private readonly sl: FileSystemDirectoryHandle;
  /** .safelight/blobs/, once opened; created only by the first put. */
  private dir: FileSystemDirectoryHandle | null = null;

  constructor(sl: FileSystemDirectoryHandle) {
    this.sl = sl;
  }

  private async created(): Promise<FileSystemDirectoryHandle> {
    if (!this.dir) this.dir = await this.sl.getDirectoryHandle("blobs", { create: true });
    return this.dir;
  }

  /** The blobs dir, or null when the project has never stored one. */
  private async existing(): Promise<FileSystemDirectoryHandle | null> {
    if (!this.dir) {
      try {
        this.dir = await this.sl.getDirectoryHandle("blobs");
      } catch {
        return null;
      }
    }
    return this.dir;
  }

  async get(photoId: string, key: string): Promise<Uint8Array | null> {
    const dir = await this.existing();
    if (!dir) return null;
    const blob = await readBlob(dir, blobName(photoId, key));
    if (!blob) return null;
    try {
      return new Uint8Array(await blob.arrayBuffer());
    } catch {
      return null;
    }
  }

  async put(photoId: string, key: string, data: Uint8Array | null): Promise<void> {
    const dir = await this.created();
    const name = blobName(photoId, key);
    if (data == null) {
      await removeEntry(dir, name);
      return;
    }
    // Copy into a fresh ArrayBuffer-backed Blob so a view over a larger buffer
    // (or a SharedArrayBuffer) is written as exactly its `data` bytes.
    await writeBlob(dir, name, new Blob([data.slice()]));
  }

  /** Remove every blob of each photo, best effort. The dir is opened without
   *  creating it, so blobs written in an earlier session are reached too, but a
   *  project that never stored one doesn't get an empty dir. */
  async deletePhotoBlobs(ids: readonly string[]): Promise<void> {
    const dir = await this.existing();
    if (!dir) return;
    const owners = new Set(ids.map(safeName));
    // Listed once, not per photo; a name belongs to the photo whose safe name is the
    // text before one of its dots.
    const ownedBy = (name: string): boolean => {
      for (let dot = name.indexOf("."); dot >= 0; dot = name.indexOf(".", dot + 1))
        if (owners.has(name.slice(0, dot))) return true;
      return false;
    };
    try {
      for await (const name of listNames(dir))
        if (typeof name === "string" && ownedBy(name)) await removeEntry(dir, name);
    } catch {
      /* best-effort cleanup */
    }
  }
}
