// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Round-trip tests for the export EXIF writer (issue #93). Sources are built
// with the shared TIFF fixture builder — big-endian, like most camera files,
// so the little-endian normalisation is exercised — then harvested with the
// catalog reader, serialized, embedded, and read back through parseExif, the
// same reader the app trusts for camera bytes. Run with `npm test`.

import { describe, it, expect } from "vitest";
import * as UTIF from "utif2";
import { parseExif, readExifEntries, type RawExifIfds } from "@/catalog/exif";
import {
  APP0,
  APP1,
  SOS,
  ascii,
  blobOf,
  buildTiff,
  exifPayload,
  jfifPayload,
  jpeg,
  latin1,
  long,
  rational,
  segment,
  short,
  utf8,
} from "@/catalog/tiff-fixture";
import { buildIccProfile, crc32, embedColorProfile } from "@/rendering/color-space";
import { buildExportIfds, embedExif, serializeExifTiff, type ExportIfds } from "./exif-write";
import { encodeTiff } from "./tiff";

// A camera-style source: descriptive tags worth carrying over, plus exactly the
// entries the harvest must drop — structural pointers, orientation, camera
// software, MakerNote and the tags the export overrides.
const SOURCE_TIFF = buildTiff({
  le: false,
  ifd0: [
    [0x010f, ascii("TestCam Industries")], // Make
    [0x0110, ascii("TC-1000")], // Model
    [0x0111, long(9999)], // StripOffsets — structural, must not survive
    [0x0112, short(6)], // Orientation — export bakes pixels upright
    [0x0131, ascii("CameraFW 1.0")], // Software — export writes its own
    [0x013b, ascii("Ansel Adams")], // Artist
    [0x8298, ascii("(C) 2026")], // Copyright
  ],
  exif: [
    [0x829a, rational([1, 250])], // ExposureTime
    [0x829d, rational([28, 10])], // FNumber
    [0x8827, short(1600)], // ISO
    [0x9003, ascii("2026:07:26 14:30:05")], // DateTimeOriginal
    [0x920a, rational([2350, 100])], // FocalLength
    [0x927c, utf8(7, "MAKERNOTEBYTES")], // MakerNote — offset-dependent, dropped
    [0xa001, short(2)], // ColorSpace — overridden per export
    [0xa002, long(6000)], // PixelXDimension — overridden per export
  ],
  gps: [
    [0x0001, ascii("N")],
    [0x0002, rational([37, 1], [48, 1], [30, 1])],
    [0x0003, ascii("W")],
    [0x0004, rational([122, 1], [16, 1], [0, 1])],
  ],
});

async function harvestSource(): Promise<RawExifIfds> {
  const meta = await readExifEntries(blobOf(SOURCE_TIFF));
  expect(meta).not.toBeNull();
  return meta!;
}

const exportIfds = async (
  overrides: Partial<Parameters<typeof buildExportIfds>[1]> = {},
): Promise<ExportIfds> =>
  buildExportIfds(await harvestSource(), {
    width: 2048,
    height: 1365,
    srgb: true,
    includeLocation: true,
    ...overrides,
  });

// Minimal little-endian IFD walk for tags parseExif does not surface
// (pixel dimensions, sub-IFD pointers).
function leTagValue(tiff: Uint8Array, ifdAt: number, tag: number): number | undefined {
  const dv = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const n = dv.getUint16(ifdAt, true);
  for (let i = 0; i < n; i++) {
    const p = ifdAt + 2 + i * 12;
    if (dv.getUint16(p, true) !== tag) continue;
    return dv.getUint16(p + 2, true) === 3 ? dv.getUint16(p + 8, true) : dv.getUint32(p + 8, true);
  }
  return undefined;
}

const ifd0At = (tiff: Uint8Array): number =>
  new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength).getUint32(4, true);

describe("readExifEntries", () => {
  it("keeps descriptive tags and drops structural, overridden and MakerNote entries", async () => {
    const meta = await harvestSource();
    const tags = (entries: { tag: number }[]) => entries.map((e) => e.tag);
    expect(tags(meta.ifd0)).toEqual(
      expect.arrayContaining([0x010f, 0x0110, 0x013b, 0x8298]),
    );
    expect(tags(meta.ifd0)).not.toContain(0x0111); // StripOffsets
    expect(tags(meta.ifd0)).not.toContain(0x0112); // Orientation
    expect(tags(meta.ifd0)).not.toContain(0x0131); // Software
    expect(tags(meta.exif)).toContain(0x829a);
    expect(tags(meta.exif)).not.toContain(0x927c); // MakerNote
    expect(tags(meta.exif)).not.toContain(0xa001); // ColorSpace
    expect(tags(meta.exif)).not.toContain(0xa002); // PixelXDimension
    expect(meta.gps.length).toBeGreaterThan(0);
  });

  it("returns null for a container without EXIF", async () => {
    expect(await readExifEntries(new Blob([new Uint8Array(64)]))).toBeNull();
  });
});

describe("serializeExifTiff", () => {
  it("round-trips a big-endian source through parseExif with export overrides", async () => {
    const tiff = serializeExifTiff(await exportIfds());
    const exif = await parseExif(blobOf(tiff as Uint8Array<ArrayBuffer>));

    expect(exif.cameraMake).toBe("TestCam Industries");
    expect(exif.cameraModel).toBe("TC-1000");
    expect(exif.artist).toBe("Ansel Adams");
    expect(exif.copyright).toBe("(C) 2026");
    expect(exif.shutterSpeed).toBe("1/250");
    expect(exif.aperture).toBe(2.8);
    expect(exif.iso).toBe(1600);
    expect(exif.focalLength).toBe(24); // 23.5 mm, reported as a whole number
    expect(exif.dateTimeOriginal).toBe("2026:07:26 14:30:05");
    expect(exif.gpsLatitude).toBe(37.808333);
    expect(exif.gpsLongitude).toBe(-122.266667);

    // Export-time overrides.
    expect(exif.orientation).toBe(1);
    expect(exif.software).toBe(`Safelight ${__APP_VERSION__}`);
    expect(exif.colorSpace).toBe("sRGB");
  });

  it("writes the exported pixel dimensions into the Exif IFD", async () => {
    const tiff = serializeExifTiff(await exportIfds());
    const exifIfd = leTagValue(tiff, ifd0At(tiff), 0x8769)!;
    expect(leTagValue(tiff, exifIfd, 0xa002)).toBe(2048); // PixelXDimension
    expect(leTagValue(tiff, exifIfd, 0xa003)).toBe(1365); // PixelYDimension
  });

  it("tags a wide-gamut export Uncalibrated, leaving the ICC to name the profile", async () => {
    const tiff = serializeExifTiff(await exportIfds({ srgb: false }));
    expect((await parseExif(blobOf(tiff as Uint8Array<ArrayBuffer>))).colorSpace).toBe(
      "Uncalibrated",
    );
  });

  it("omits the GPS IFD entirely unless location is opted in", async () => {
    const tiff = serializeExifTiff(await exportIfds({ includeLocation: false }));
    const exif = await parseExif(blobOf(tiff as Uint8Array<ArrayBuffer>));
    expect(exif.gpsLatitude).toBeUndefined();
    expect(leTagValue(tiff, ifd0At(tiff), 0x8825)).toBeUndefined(); // no GPS pointer
    expect(exif.cameraMake).toBe("TestCam Industries"); // the rest is intact
  });
});

describe("buildExportIfds — catalog-edited metadata", () => {
  const EDITED = {
    artist: "Robin Example",
    copyright: "© 2026 Robin Example",
    imageDescription: "Sunset over the pier",
  };

  const parsed = async (ifds: ExportIfds) =>
    parseExif(blobOf(serializeExifTiff(ifds) as Uint8Array<ArrayBuffer>));

  it("overrides the source file's descriptive tags with catalog-edited values", async () => {
    const exif = await parsed(await exportIfds({ edited: EDITED }));
    expect(exif.artist).toBe("Robin Example");
    expect(exif.copyright).toBe("© 2026 Robin Example");
    expect(exif.imageDescription).toBe("Sunset over the pier");
    expect(exif.cameraMake).toBe("TestCam Industries"); // untouched harvest survives
  });

  it("keeps the source file's tags when edited fields are blank", async () => {
    const exif = await parsed(await exportIfds({ edited: { artist: "", copyright: undefined } }));
    expect(exif.artist).toBe("Ansel Adams");
    expect(exif.copyright).toBe("(C) 2026");
  });

  it("replaces the source GPS coordinates with catalog-edited ones", async () => {
    const exif = await parsed(
      await exportIfds({ edited: { gpsLatitude: 49.5, gpsLongitude: -123.25 } }),
    );
    expect(exif.gpsLatitude).toBe(49.5);
    expect(exif.gpsLongitude).toBe(-123.25);
  });

  it("encodes edited coordinates as D/M/S without visible precision loss", async () => {
    const exif = await parsed(
      await exportIfds({ edited: { gpsLatitude: 51.507222, gpsLongitude: -0.1275 } }),
    );
    expect(exif.gpsLatitude).toBe(51.507222);
    expect(exif.gpsLongitude).toBe(-0.1275);
  });

  it("carries seconds rounding into the next unit instead of writing 60″", async () => {
    const exif = await parsed(
      await exportIfds({ edited: { gpsLatitude: 9.99999999, gpsLongitude: -0.99999999 } }),
    );
    expect(exif.gpsLatitude).toBe(10);
    expect(exif.gpsLongitude).toBe(-1);
  });

  it("drops edited GPS along with the source's when location is not opted in", async () => {
    const tiff = serializeExifTiff(
      await exportIfds({
        includeLocation: false,
        edited: { gpsLatitude: 49.5, gpsLongitude: -123.25 },
      }),
    );
    expect(leTagValue(tiff, ifd0At(tiff), 0x8825)).toBeUndefined();
  });

  it("ignores a lone coordinate rather than writing half a position", async () => {
    const exif = await parsed(await exportIfds({ edited: { gpsLatitude: 49.5 } }));
    expect(exif.gpsLatitude).toBe(37.808333); // the source IFD survives untouched
    expect(exif.gpsLongitude).toBe(-122.266667);
  });

  it("builds a complete EXIF block from catalog metadata alone", async () => {
    const exif = await parsed(
      buildExportIfds(null, {
        width: 800,
        height: 600,
        srgb: true,
        includeLocation: true,
        edited: { ...EDITED, gpsLatitude: 49.5, gpsLongitude: -123.25 },
      }),
    );
    expect(exif.artist).toBe("Robin Example");
    expect(exif.gpsLatitude).toBe(49.5);
    expect(exif.gpsLongitude).toBe(-123.25);
    expect(exif.cameraMake).toBeUndefined();
    expect(exif.software).toBe(`Safelight ${__APP_VERSION__}`);
    expect(exif.orientation).toBe(1);
  });
});

describe("embedExif — JPEG", () => {
  const bareJpeg = () => jpeg([segment(APP0, jfifPayload), segment(SOS, latin1("scan"))]);

  it("inserts an Exif APP1 after the JFIF APP0 that parseExif can read back", async () => {
    const tiff = serializeExifTiff(await exportIfds());
    const out = await embedExif(new Blob([bareJpeg()], { type: "image/jpeg" }), tiff);
    const bytes = new Uint8Array(await out.arrayBuffer());

    // Segment order: SOI, then APP0 (JFIF pins it there), then the Exif APP1.
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
    expect(bytes[2]).toBe(0xff);
    expect(bytes[3]).toBe(APP0);
    const app0Len = (bytes[4] << 8) | bytes[5];
    expect(bytes[4 + app0Len]).toBe(0xff);
    expect(bytes[5 + app0Len]).toBe(APP1);

    const exif = await parseExif(out);
    expect(exif.cameraMake).toBe("TestCam Industries");
    expect(exif.orientation).toBe(1);
  });

  it("replaces a pre-existing Exif APP1 instead of stacking a second one", async () => {
    const stale = buildTiff({ le: true, ifd0: [[0x010f, ascii("Old")]] });
    const src = jpeg([segment(APP1, exifPayload(stale)), segment(SOS, latin1("scan"))]);
    const tiff = serializeExifTiff(await exportIfds());
    const out = await embedExif(new Blob([src], { type: "image/jpeg" }), tiff);

    expect((await parseExif(out)).cameraMake).toBe("TestCam Industries");
    const bytes = new Uint8Array(await out.arrayBuffer());
    let app1Count = 0;
    let i = 2;
    while (i + 4 <= bytes.length && bytes[i] === 0xff && bytes[i + 1] !== SOS) {
      if (bytes[i + 1] === APP1) app1Count++;
      i += 2 + ((bytes[i + 2] << 8) | bytes[i + 3]);
    }
    expect(app1Count).toBe(1);
  });

  it("coexists with an embedded ICC profile", async () => {
    const profiled = await embedColorProfile(
      new Blob([bareJpeg()], { type: "image/jpeg" }),
      "adobe-rgb",
    );
    const tiff = serializeExifTiff(await exportIfds({ srgb: false }));
    const out = await embedExif(profiled, tiff);

    expect((await parseExif(out)).cameraMake).toBe("TestCam Industries");
    const bytes = new Uint8Array(await out.arrayBuffer());
    const text = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
    expect(text).toContain("ICC_PROFILE\0");
    // The Exif APP1 sits ahead of the ICC APP2, as the segment order requires.
    expect(text.indexOf("Exif\0\0")).toBeLessThan(text.indexOf("ICC_PROFILE\0"));
  });

  it("returns the original blob for a container it does not understand", async () => {
    const gif = new Blob([latin1("GIF89a")], { type: "image/gif" });
    expect(await embedExif(gif, serializeExifTiff(await exportIfds()))).toBe(gif);
  });
});

describe("embedExif — PNG", () => {
  function pngChunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
    const c = new Uint8Array(12 + data.length);
    const dv = new DataView(c.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) c[4 + i] = type.charCodeAt(i);
    c.set(data, 8);
    dv.setUint32(8 + data.length, crc32(c.subarray(4, 8 + data.length)));
    return c;
  }

  it("inserts a CRC-valid eXIf chunk before the first IDAT", async () => {
    const sig = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const png = new Blob(
      [sig, pngChunk("IHDR", new Uint8Array(13)), pngChunk("IDAT", new Uint8Array(4)), pngChunk("IEND", new Uint8Array(0))],
      { type: "image/png" },
    );
    const tiff = serializeExifTiff(await exportIfds());
    const bytes = new Uint8Array(await (await embedExif(png, tiff)).arrayBuffer());

    const chunks: { type: string; data: Uint8Array; crcOk: boolean }[] = [];
    const dv = new DataView(bytes.buffer);
    for (let i = 8; i + 8 <= bytes.length; ) {
      const len = dv.getUint32(i);
      const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
      chunks.push({
        type,
        data: bytes.subarray(i + 8, i + 8 + len),
        crcOk: dv.getUint32(i + 8 + len) === crc32(bytes.subarray(i + 4, i + 8 + len)),
      });
      i += 12 + len;
    }
    expect(chunks.map((c) => c.type)).toEqual(["IHDR", "eXIf", "IDAT", "IEND"]);
    const exifChunk = chunks[1];
    expect(exifChunk.crcOk).toBe(true);
    // The eXIf payload is the bare TIFF block — parseExif reads it directly.
    expect(
      (await parseExif(new Blob([Uint8Array.from(exifChunk.data)]))).cameraMake,
    ).toBe("TestCam Industries");
  });
});

describe("embedExif — WebP", () => {
  // A minimal lossy WebP: RIFF/WEBP wrapper around a VP8 chunk whose frame
  // header encodes the dimensions the VP8X upgrade must preserve.
  function vp8Webp(width: number, height: number): Uint8Array<ArrayBuffer> {
    const payload = new Uint8Array(10);
    payload.set([0x9d, 0x01, 0x2a], 3); // key-frame start code after the frame tag
    payload[6] = width & 0xff;
    payload[7] = (width >> 8) & 0x3f;
    payload[8] = height & 0xff;
    payload[9] = (height >> 8) & 0x3f;
    const out = new Uint8Array(12 + 8 + payload.length);
    const dv = new DataView(out.buffer);
    out.set(latin1("RIFF"), 0);
    dv.setUint32(4, 4 + 8 + payload.length, true);
    out.set(latin1("WEBP"), 8);
    out.set(latin1("VP8 "), 12);
    dv.setUint32(16, payload.length, true);
    out.set(payload, 20);
    return out;
  }

  const fourccAt = (b: Uint8Array, i: number) =>
    String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);

  it("wraps a simple VP8 stream in VP8X and appends the EXIF chunk after the image", async () => {
    const tiff = serializeExifTiff(await exportIfds());
    const src = new Blob([vp8Webp(320, 240)], { type: "image/webp" });
    const bytes = new Uint8Array(await (await embedExif(src, tiff)).arrayBuffer());

    expect(fourccAt(bytes, 12)).toBe("VP8X");
    expect(bytes[20] & 0x08).toBe(0x08); // EXIF flag
    // Canvas fields carry width-1 / height-1.
    expect(bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)).toBe(319);
    expect(bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)).toBe(239);

    // Chunk order: VP8X, image data, EXIF last.
    expect(fourccAt(bytes, 30)).toBe("VP8 ");
    const exifAt = bytes.length - (8 + tiff.length + (tiff.length & 1));
    expect(fourccAt(bytes, exifAt)).toBe("EXIF");
    const payload = bytes.subarray(exifAt + 8, exifAt + 8 + tiff.length);
    expect((await parseExif(new Blob([Uint8Array.from(payload)]))).iso).toBe(1600);
  });

  it("adds EXIF alongside an ICC profile in an existing VP8X container", async () => {
    const profiled = await embedColorProfile(
      new Blob([vp8Webp(64, 64)], { type: "image/webp" }),
      "adobe-rgb",
    );
    const tiff = serializeExifTiff(await exportIfds({ srgb: false }));
    const bytes = new Uint8Array(await (await embedExif(profiled, tiff)).arrayBuffer());

    expect(fourccAt(bytes, 12)).toBe("VP8X");
    expect(bytes[20] & 0x20).toBe(0x20); // ICC flag survives
    expect(bytes[20] & 0x08).toBe(0x08); // EXIF flag added
    expect(fourccAt(bytes, 30)).toBe("ICCP"); // ICCP stays ahead of the image
  });
});

describe("encodeTiff with metadata", () => {
  const sample8 = () =>
    new Uint8Array([
      255, 0, 0, 255, /**/ 0, 255, 0, 255,
      0, 0, 255, 255, /**/ 255, 255, 0, 255,
    ]);

  it("stays a decodable TIFF and carries the woven-in EXIF", async () => {
    const meta = await exportIfds({ width: 2, height: 2 });
    const bytes = encodeTiff(sample8(), 2, 2, {
      bitDepth: 8,
      icc: buildIccProfile("adobe-rgb"),
      meta,
    });
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

    const ifds = UTIF.decode(ab);
    expect(ifds.length).toBe(1);
    UTIF.decodeImage(ab, ifds[0]);
    const rgba = UTIF.toRGBA8(ifds[0]);
    expect([rgba[0], rgba[1], rgba[2]]).toEqual([255, 0, 0]);
    expect([rgba[12], rgba[13], rgba[14]]).toEqual([255, 255, 0]);

    const exif = await parseExif(new Blob([Uint8Array.from(bytes)]));
    expect(exif.cameraMake).toBe("TestCam Industries");
    expect(exif.iso).toBe(1600);
    expect(exif.gpsLatitude).toBe(37.808333);
    expect(exif.software).toBe(`Safelight ${__APP_VERSION__}`);
    expect(exif.orientation).toBe(1);
  });

  it("encodes identically to the metadata-free layout when meta is absent", () => {
    const plain = encodeTiff(sample8(), 2, 2, { bitDepth: 8 });
    const ifds = UTIF.decode(
      plain.buffer.slice(plain.byteOffset, plain.byteOffset + plain.byteLength) as ArrayBuffer,
    );
    expect(ifds.length).toBe(1);
    expect(Number((ifds[0]["t258"] as number[])[0])).toBe(8);
  });
});
