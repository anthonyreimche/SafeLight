// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { CatalogPhoto } from "@/catalog/types";

export type RawPhotoOptions = Partial<CatalogPhoto> & {
  /** The original's bytes, or how many zero bytes it holds. */
  bytes?: Uint8Array<ArrayBuffer> | number;
  /** Hears each read of the original through its file handle; a promise it
   *  answers holds the read until it settles. */
  onRead?: () => void | Promise<void>;
};

/** A RAW's catalog record whose file handle serves its original under `name`:
 *  64 zero bytes unless `bytes` says otherwise. Any other option overrides the
 *  record's field. */
export function rawPhoto(
  name: string,
  { bytes = 64, onRead, ...fields }: RawPhotoOptions = {},
): CatalogPhoto {
  const file = new File([typeof bytes === "number" ? new Uint8Array(bytes) : bytes], name);
  return {
    id: `id:${name}`,
    filename: name,
    relPath: name,
    folder: "",
    directoryHandle: null,
    fileHandle: {
      kind: "file",
      name,
      getFile: async () => {
        await onRead?.();
        return file;
      },
    } as FileSystemFileHandle,
    thumbnailBlob: null,
    thumbnailUrl: null,
    width: 6000,
    height: 4000,
    fileSize: file.size,
    mimeType: "",
    rating: 0,
    colorLabel: "none",
    flag: "none",
    rotation: 0,
    keywords: [],
    dateCreated: 0,
    dateImported: 0,
    exif: {},
    ...fields,
  };
}
