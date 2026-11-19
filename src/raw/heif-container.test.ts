// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it } from "vitest";
import { isHeifHead, readHeifContainer, readHeifExif, readHeifXmp } from "./heif-container";
import { HEIF_P3_10, HEIF_SRGB8, heifBlob, heifBytes } from "./heif-fixtures.test-support";

type Bytes = number[];

const u8 = (v: number): Bytes => [v & 0xff];
const u16 = (v: number): Bytes => [(v >>> 8) & 0xff, v & 0xff];
const u32 = (v: number): Bytes => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
const u64 = (v: number): Bytes => [...u32(Math.floor(v / 2 ** 32)), ...u32(v >>> 0)];
const ascii = (s: string): Bytes => Array.from(s, (c) => c.charCodeAt(0));
const cstr = (s: string): Bytes => [...ascii(s), 0];

const box = (type: string, ...payload: Bytes[]): Bytes => {
  const body = payload.flat();
  return [...u32(8 + body.length), ...ascii(type), ...body];
};
const fullBox = (type: string, version: number, flags: number, ...payload: Bytes[]): Bytes =>
  box(type, [version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff], ...payload);
const largeBox = (type: string, ...payload: Bytes[]): Bytes => {
  const body = payload.flat();
  return [...u32(1), ...ascii(type), ...u64(16 + body.length), ...body];
};

const ftyp = (major = "heic", compatible = ["mif1", "heic"]): Bytes =>
  box("ftyp", ascii(major), u32(0), ...compatible.map(ascii));

const infe = (id: number, type: string, ...extra: Bytes[]): Bytes =>
  fullBox("infe", 2, 0, u16(id), u16(0), ascii(type), cstr(""), ...extra);

const TIFF: Bytes = [0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0];
const EXIF_ITEM: Bytes = [...u32(0), ...TIFF];
const XMP = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF/></x:xmpmeta>';

interface Synthetic {
  bytes: Uint8Array<ArrayBuffer>;
  exifAt: number;
}

/** A HEIF whose primary item 1 has every property the reader looks at, an
 *  Exif item 2 placed past `exifPast` in the file, and an XMP item 3 kept in
 *  the meta box's idat (construction method 1). */
function synthetic(exifPast = 0, options: { large?: boolean } = {}): Synthetic {
  const props: Bytes[] = [
    fullBox("ispe", 0, 0, u32(4032), u32(3024)),
    box("irot", u8(1)),
    box("imir", u8(1)),
    box("colr", ascii("nclx"), u16(12), u16(13), u16(6), u8(0x80)),
    box("colr", ascii("prof"), [1, 2, 3, 4]),
    fullBox("pixi", 0, 0, u8(3), u8(10), u8(10), u8(10)),
  ];
  const xmp = ascii(XMP);
  const build = (exifOffset: number): Bytes => {
    const meta = (options.large ? largeBox : box)(
      "meta",
      [0, 0, 0, 0],
      fullBox("hdlr", 0, 0, u32(0), ascii("pict"), u32(0), u32(0), u32(0), cstr("")),
      fullBox("pitm", 0, 0, u16(1)),
      fullBox(
        "iinf",
        0,
        0,
        u16(3),
        infe(1, "hvc1"),
        infe(2, "Exif"),
        infe(3, "mime", cstr("application/rdf+xml")),
      ),
      fullBox(
        "iloc",
        1,
        0,
        [0x84, 0x40],
        u16(3),
        [...u16(1), ...u16(0), ...u16(0), ...u32(0), ...u16(1), ...u64(0), ...u32(0)],
        [...u16(2), ...u16(0), ...u16(0), ...u32(0), ...u16(1), ...u64(exifOffset), ...u32(EXIF_ITEM.length)],
        [...u16(3), ...u16(1), ...u16(0), ...u32(0), ...u16(1), ...u64(4), ...u32(xmp.length)],
      ),
      box("idat", [9, 9, 9, 9], xmp),
      fullBox("iref", 0, 0, box("cdsc", u16(2), u16(1), u16(1)), box("cdsc", u16(3), u16(1), u16(1))),
      box(
        "iprp",
        box("ipco", ...props),
        fullBox("ipma", 0, 0, u32(1), u16(1), u8(props.length), props.map((_, i) => 0x80 | (i + 1))),
      ),
    );
    return [...ftyp(), ...meta];
  };
  const head = build(0);
  const exifAt = Math.max(head.length + 8, exifPast);
  const file = build(exifAt);
  const mdatSize = exifAt + EXIF_ITEM.length - file.length;
  const bytes = new Uint8Array(exifAt + EXIF_ITEM.length);
  bytes.set(file);
  bytes.set(u32(mdatSize), file.length);
  bytes.set(ascii("mdat"), file.length + 4);
  bytes.set(EXIF_ITEM, exifAt);
  return { bytes, exifAt };
}

const blobOf = (bytes: Uint8Array<ArrayBuffer>): Blob => new Blob([bytes]);

describe("isHeifHead", () => {
  it("accepts the HEIF brands and refuses other files", () => {
    expect(isHeifHead(heifBytes(HEIF_SRGB8))).toBe(true);
    expect(isHeifHead(new Uint8Array(ftyp("msf1", ["msf1"])))).toBe(true);
    expect(isHeifHead(new Uint8Array(ftyp("avif", ["avif"])))).toBe(false);
    expect(isHeifHead(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(false);
    expect(isHeifHead(new Uint8Array(4))).toBe(false);
  });
});

describe("readHeifContainer", () => {
  it("reads the srgb8 fixture's primary item", async () => {
    const info = await readHeifContainer(heifBlob(HEIF_SRGB8));
    expect(info).not.toBeNull();
    expect(info).toMatchObject({
      primaryItem: 1,
      width: 64,
      height: 64,
      rotation: 90,
      mirrorAxis: null,
      nclx: { primaries: 1, transfer: 13, matrix: 6, fullRange: true },
      icc: null,
      bitDepth: 8,
    });
    expect(info?.exif).toHaveLength(1);
    expect(info?.xmp).toBeNull();
  });

  it("reads the p3_10 fixture's colour and bit depth", async () => {
    const info = await readHeifContainer(heifBlob(HEIF_P3_10));
    expect(info).toMatchObject({
      rotation: 0,
      nclx: { primaries: 12, transfer: 13, matrix: 0, fullRange: true },
      bitDepth: 10,
      exif: null,
    });
  });

  it("reads every property of a synthetic primary item", async () => {
    const { bytes, exifAt } = synthetic();
    const info = await readHeifContainer(blobOf(bytes));
    expect(info).toMatchObject({
      primaryItem: 1,
      width: 4032,
      height: 3024,
      rotation: 270,
      mirrorAxis: "horizontal",
      nclx: { primaries: 12, transfer: 13, matrix: 6, fullRange: true },
      bitDepth: 10,
      exif: [{ offset: exifAt, length: EXIF_ITEM.length }],
    });
    expect(Array.from(info?.icc ?? [])).toEqual([1, 2, 3, 4]);
  });

  it("reads a meta box with a 64-bit size", async () => {
    const info = await readHeifContainer(blobOf(synthetic(0, { large: true }).bytes));
    expect(info?.width).toBe(4032);
  });

  it("answers null for damaged or foreign input, never throwing", async () => {
    const { bytes } = synthetic();
    for (const cut of [10, 40, 120, 300]) {
      await expect(readHeifContainer(blobOf(bytes.slice(0, cut)))).resolves.toBeNull();
    }
    await expect(readHeifContainer(new Blob([new Uint8Array(64)]))).resolves.toBeNull();
    await expect(readHeifContainer(new Blob([new Uint8Array(ftyp("avif", ["avif"]))]))).resolves.toBeNull();
    const lying = bytes.slice();
    lying.set(u32(0x7fffffff), ftyp().length);
    await expect(readHeifContainer(blobOf(lying))).resolves.toBeNull();
    const junk = new Uint8Array(4096);
    for (let i = 0; i < junk.length; i++) junk[i] = (i * 7919) & 0xff;
    junk.set(ftyp(), 0);
    await expect(readHeifContainer(blobOf(junk))).resolves.toBeNull();
  });
});

describe("readHeifExif / readHeifXmp", () => {
  it("returns the Exif item's TIFF, past the 4-byte header offset", async () => {
    const tiff = await readHeifExif(heifBlob(HEIF_SRGB8));
    expect(tiff).not.toBeNull();
    const magic = String.fromCharCode(tiff![0], tiff![1]);
    expect(["II", "MM"]).toContain(magic);
  });

  it("finds an Exif item that sits past 1 MiB", async () => {
    const { bytes } = synthetic(3 << 20);
    expect(Array.from((await readHeifExif(blobOf(bytes))) ?? [])).toEqual(TIFF);
  });

  it("returns XMP kept in idat", async () => {
    const xmp = await readHeifXmp(blobOf(synthetic().bytes));
    expect(new TextDecoder().decode(xmp ?? new Uint8Array())).toBe(XMP);
  });

  it("returns null when there is no such item", async () => {
    await expect(readHeifExif(heifBlob(HEIF_P3_10))).resolves.toBeNull();
    await expect(readHeifXmp(heifBlob(HEIF_SRGB8))).resolves.toBeNull();
    await expect(readHeifExif(new Blob([new Uint8Array(8)]))).resolves.toBeNull();
  });
});
