// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A HEIF file keeps its Exif and XMP as items of its meta box, anywhere in
// the file, not at its head as a JPEG or TIFF does.

import { describe, expect, it } from "vitest";
import { HEIF_P3_10, HEIF_SRGB8, heifBlob, heifBytes } from "@/raw/heif-fixtures.test-support";
import { parseExif, parseXmp, readExifEntries } from "./exif";

const XMP =
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
  '<rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="4"/></rdf:RDF></x:xmpmeta>';

const u32 = (v: number): number[] => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];

const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));
const box = (type: string, ...payload: number[][]): number[] => {
  const body = payload.flat();
  return [...u32(8 + body.length), ...ascii(type), ...body];
};
const full = (type: string, ...payload: number[][]): number[] => box(type, [0, 0, 0, 0], ...payload);

/** A HEIF with a primary item 1 and an XMP item 2, its packet in idat. */
function xmpHeif(xmp: string): Blob {
  const packet = ascii(xmp);
  const infe = (id: number, type: string, ...extra: number[][]): number[] =>
    box("infe", [2, 0, 0, 0, 0, id, 0, 0], ascii(type), [0], ...extra);
  const iloc = box(
    "iloc",
    [1, 0, 0, 0, 0x44, 0x00, 0, 1],
    [0, 2, 0, 1, 0, 0, 0, 1],
    u32(0),
    u32(packet.length),
  );
  return new Blob([
    new Uint8Array([
      ...box("ftyp", ascii("heic"), u32(0), ascii("mif1")),
      ...full(
        "meta",
        full("hdlr", u32(0), ascii("pict"), u32(0), u32(0), u32(0), [0]),
        full("pitm", [0, 1]),
        full("iinf", [0, 2], infe(1, "hvc1"), infe(2, "mime", ascii("application/rdf+xml"), [0])),
        iloc,
        box("idat", packet),
        box("iprp", box("ipco"), full("ipma", u32(0))),
      ),
    ]),
  ]);
}

/** srgb8 with its Exif item moved past 2 MiB: the item's iloc extent is
 *  rewritten and its bytes appended after a free box. */
function farItems(): Blob {
  const src = heifBytes(HEIF_SRGB8);
  const view = new DataView(src.buffer);
  // srgb8's iloc (version 0, 4-byte base offsets, offsets and lengths) lists
  // item 2, the Exif item, last, with one extent: base offset, extent count,
  // extent offset and length close the box.
  const iloc = src.findIndex((_, i) => String.fromCharCode(...src.subarray(i, i + 4)) === "iloc");
  const ilocEnd = iloc - 4 + view.getUint32(iloc - 4);
  const base = view.getUint32(ilocEnd - 14);
  const exifAt = base + view.getUint32(ilocEnd - 8);
  const exifLength = view.getUint32(ilocEnd - 4);
  const exif = src.slice(exifAt, exifAt + exifLength);
  const far = (2 << 20) + 17;
  view.setUint32(ilocEnd - 8, far - base);
  const out = new Uint8Array(far + exif.length);
  out.set(src);
  out.set([...u32(far - src.length), 0x66, 0x72, 0x65, 0x65], src.length);
  out.set(exif, far);
  return new Blob([out]);
}

describe("HEIF metadata", () => {
  it("reads the Exif item of a HEIC", async () => {
    const exif = await parseExif(heifBlob(HEIF_SRGB8));
    expect(exif).toMatchObject({
      cameraMake: "Apple",
      cameraModel: "iPhone 15 Pro",
      dateTimeOriginal: "2026:05:04 13:14:15",
      iso: 125,
      orientation: 6,
    });
  });

  it("reads an Exif item that sits past 1 MiB", async () => {
    const exif = await parseExif(farItems());
    expect(exif.cameraMake).toBe("Apple");
    expect(exif.iso).toBe(125);
  });

  it("harvests the Exif item's entries for export", async () => {
    const entries = await readExifEntries(heifBlob(HEIF_SRGB8));
    expect(entries?.ifd0.map((e) => e.tag)).toContain(0x010f);
    expect(entries?.exif.map((e) => e.tag)).toContain(0x8827);
  });

  it("answers empty for a HEIC with no Exif or XMP item", async () => {
    await expect(parseExif(heifBlob(HEIF_P3_10))).resolves.toEqual({});
    await expect(readExifEntries(heifBlob(HEIF_P3_10))).resolves.toBeNull();
    await expect(parseXmp(heifBlob(HEIF_SRGB8))).resolves.toEqual({});
  });

  it("reads an XMP item", async () => {
    await expect(parseXmp(xmpHeif(XMP))).resolves.toMatchObject({ rating: 4 });
  });
});
