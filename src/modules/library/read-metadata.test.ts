// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryFs } from "@/project/memory-fs.test-support";
import { APP1, APP2, ascii, buildTiff, concat, exifPayload, jpeg, latin1, segment } from "@/catalog/tiff-fixture";

const h = vi.hoisted(() => ({ bridge: null as unknown }));

vi.mock("@/native/privileged", () => ({
  privilegedFs: () => h.bridge,
}));

import { nativeDirectoryHandle } from "@/project/native-fs";
import { METADATA_FIRST_BYTES, METADATA_HEAD_BYTES, readMetadata } from "./read-metadata";

const MIB = 2 ** 20;

const tiff = buildTiff({
  le: true,
  ifd0: [[0x0110, ascii("Z8")]],
  exif: [
    [0x9003, ascii("2026:06:30 14:05:42")],
    [0x9291, ascii("541")],
  ],
});

/** A TIFF-based RAW: its EXIF at the start, then `tail` bytes of sensor data. */
const raw = (tail: number) => concat([tiff, new Uint8Array(tail)]);

let fs: MemoryFs;

beforeEach(() => {
  fs = new MemoryFs("/card");
  h.bridge = fs;
});

describe("readMetadata", () => {
  it("reads a desktop file's EXIF from its head alone", async () => {
    fs.putBytes("/card/DSC_1.NEF", raw(3 * MIB));
    const file = await nativeDirectoryHandle("/card").getFileHandle("DSC_1.NEF");
    const meta = await readMetadata(file);
    expect(meta).toMatchObject({
      exif: { cameraModel: "Z8", dateTimeOriginal: "2026:06:30 14:05:42", subSecTimeOriginal: "541" },
      dateCreated: new Date(2026, 5, 30, 14, 5, 42).getTime(),
      keywords: [],
      size: tiff.length + 3 * MIB,
    });
    expect(fs.bytesRead("/card/DSC_1.NEF")).toBeLessThanOrEqual(METADATA_FIRST_BYTES);
  });

  it("reads on to the first MiB when the capture time isn't in the first part", async () => {
    const padding = Array.from({ length: 5 }, () => segment(APP2, new Uint8Array(65_000)));
    fs.putBytes("/card/late.jpg", concat([jpeg([...padding, segment(APP1, exifPayload(tiff))]), new Uint8Array(2 * MIB)]));
    const file = await nativeDirectoryHandle("/card").getFileHandle("late.jpg");
    expect((await readMetadata(file))?.exif.dateTimeOriginal).toBe("2026:06:30 14:05:42");
    expect(fs.bytesRead("/card/late.jpg")).toBeLessThanOrEqual(METADATA_FIRST_BYTES + METADATA_HEAD_BYTES);
  });

  it("reads a JPEG blob", async () => {
    const blob = new File([jpeg([segment(APP1, exifPayload(tiff))])], "a.jpg");
    expect((await readMetadata(blob))?.exif.cameraModel).toBe("Z8");
  });

  it("dates a file without a capture time by its modification time", async () => {
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], "a.jpg", { lastModified: 1234 });
    expect(await readMetadata(file)).toMatchObject({ exif: {}, dateCreated: 1234, size: 4 });
  });

  it("reads a HEIF file whole, since its EXIF can lie anywhere", async () => {
    const ftyp = concat([new Uint8Array([0, 0, 0, 16]), latin1("ftypheic"), new Uint8Array(4)]);
    fs.putBytes("/card/IMG_1.HEIC", concat([ftyp, new Uint8Array(2 * MIB)]));
    const file = await nativeDirectoryHandle("/card").getFileHandle("IMG_1.HEIC");
    await readMetadata(file);
    expect(fs.bytesRead("/card/IMG_1.HEIC")).toBeGreaterThan(2 * MIB);
  });

  it("is null for a file Safelight doesn't import, without reading it", async () => {
    fs.putBytes("/card/notes.txt", new Uint8Array(10));
    const file = await nativeDirectoryHandle("/card").getFileHandle("notes.txt");
    expect(await readMetadata(file)).toBeNull();
    expect(fs.bytesRead("/card/notes.txt")).toBe(0);
    expect(await readMetadata(new File(["x"], "clip.mp4"))).toBeNull();
  });

  it("is null for what isn't a file handle or a blob", async () => {
    for (const bad of [null, "a.jpg", {}, { name: "a.jpg" }]) expect(await readMetadata(bad as never)).toBeNull();
  });

  it("is null when the file can't be read", async () => {
    const file = await nativeDirectoryHandle("/card").getFileHandle("gone.jpg");
    expect(await readMetadata(file)).toBeNull();
  });
});
