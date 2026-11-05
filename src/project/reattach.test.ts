// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it, vi } from "vitest";
import type { ExifData } from "@/catalog/photo";
import type { StoredPhoto } from "@/catalog/types";
import { findMoved } from "./reattach";
import type { ScannedFile } from "./scan";

const h = vi.hoisted(() => ({ exifOf: new Map<string, unknown>() }));

vi.mock("./native-fs", () => ({
  readFileSlice: async (handle: { name: string }) => ({
    data: new TextEncoder().encode(handle.name),
    size: 100,
    lastModified: 0,
    type: "",
  }),
}));
vi.mock("@/catalog/exif", () => ({
  parseExif: async (blob: Blob) => h.exifOf.get(await blob.text()),
}));

const SHOT = "2026:07:26 14:30:05";

function file(path: string, exif: ExifData): ScannedFile {
  const handle = { name: path } as FileSystemFileHandle;
  h.exifOf.set(path, exif);
  return { path, handle, parent: {} as FileSystemDirectoryHandle };
}

function record(relPath: string, exif: ExifData): StoredPhoto {
  return { relPath, fileSize: 100, dateCreated: 0, exif } as unknown as StoredPhoto;
}

describe("findMoved: sub-second capture time", () => {
  it("tells two same-name, same-size, same-second shots apart by sub-second time", async () => {
    const a = file("new/a/IMG_1.jpg", { dateTimeOriginal: SHOT, subSecTimeOriginal: "12" });
    const b = file("new/b/IMG_1.jpg", { dateTimeOriginal: SHOT, subSecTimeOriginal: "87" });
    const ra = record("old/a/IMG_1.jpg", { dateTimeOriginal: SHOT, subSecTimeOriginal: "12" });
    const rb = record("old/b/IMG_1.jpg", { dateTimeOriginal: SHOT, subSecTimeOriginal: "87" });
    const found = await findMoved([ra, rb], [a, b], false);
    expect(found.get(a)).toBe(ra);
    expect(found.get(b)).toBe(rb);
  });

  it("rejects a file whose sub-second time differs from the record's", async () => {
    const f = file("new/IMG_1.jpg", { dateTimeOriginal: SHOT, subSecTimeOriginal: "87" });
    const r = record("old/IMG_1.jpg", { dateTimeOriginal: SHOT, subSecTimeOriginal: "12" });
    expect((await findMoved([r], [f], false)).size).toBe(0);
  });

  it("compares the second alone when either side has no sub-second time", async () => {
    const f = file("new/IMG_1.jpg", { dateTimeOriginal: SHOT, subSecTimeOriginal: "87" });
    const r = record("old/IMG_1.jpg", { dateTimeOriginal: SHOT });
    expect((await findMoved([r], [f], false)).get(f)).toBe(r);
  });
});
