// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Canon CR3 keeps its EXIF as separate TIFF blocks in boxes of an ISO media file:
// CMT1 holds IFD0, CMT2 the Exif IFD, CMT4 the GPS IFD, inside a Canon uuid box
// in the moov box. These tests assemble that layout around real TIFF blocks.

import { describe, expect, it } from "vitest";
import { parseExif } from "./exif";
import { ascii, blobOf, buildTiff, concat, latin1, rational, type Bytes, type Entry } from "./tiff-fixture";

const CANON_UUID = [0x85, 0xc0, 0xb6, 0x87, 0x82, 0x0f, 0x11, 0xe0, 0x81, 0x11, 0xf4, 0xce, 0x46, 0x2b, 0x6a, 0x48];

function box(type: string, payload: Uint8Array): Bytes {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length, false);
  out.set(latin1(type), 4);
  out.set(payload, 8);
  return out;
}

/** A TIFF block whose IFD0 holds `entries`, as CMT2 and CMT4 carry them. */
const ifdBlock = (entries: readonly Entry[], le = true): Bytes => buildTiff({ le, ifd0: entries });

function cr3(parts: { cmt1?: Bytes; cmt2?: Bytes; cmt4?: Bytes }, before: Bytes[] = []): Bytes {
  const children = [
    box("CNCV", latin1("CanonCR3_001/00.10.00/00.00.00")),
    ...(parts.cmt1 ? [box("CMT1", parts.cmt1)] : []),
    ...(parts.cmt2 ? [box("CMT2", parts.cmt2)] : []),
    ...(parts.cmt4 ? [box("CMT4", parts.cmt4)] : []),
  ];
  const uuid = box("uuid", concat([new Uint8Array(CANON_UUID), ...children]));
  const ftyp = box("ftyp", concat([latin1("crx "), new Uint8Array([0, 0, 0, 1]), latin1("crx isom")]));
  return concat([ftyp, box("moov", concat([...before, uuid])), box("mdat", new Uint8Array(64))]);
}

describe("parseExif — Canon CR3", () => {
  it("reads IFD0 from CMT1 and the Exif IFD from CMT2", async () => {
    const exif = await parseExif(
      blobOf(
        cr3({
          cmt1: ifdBlock([
            [0x010f, ascii("Canon")],
            [0x0110, ascii("Canon EOS R5")],
          ]),
          cmt2: ifdBlock([
            [0x829a, rational([1, 500])],
            [0x9003, ascii("2026:05:04 10:11:12")],
            [0x9291, ascii("37")],
            [0xa431, ascii("012345678901")],
            [0xa434, ascii("RF24-70mm F2.8 L IS USM")],
          ]),
        }),
      ),
    );
    expect(exif).toMatchObject({
      cameraMake: "Canon",
      cameraModel: "Canon EOS R5",
      shutterSpeed: "1/500",
      dateTimeOriginal: "2026:05:04 10:11:12",
      subSecTimeOriginal: "37",
      bodySerial: "012345678901",
      lens: "RF24-70mm F2.8 L IS USM",
    });
  });

  it("reads big-endian blocks and skips boxes ahead of Canon's", async () => {
    const exif = await parseExif(
      blobOf(
        cr3(
          {
            cmt1: ifdBlock([[0x0110, ascii("Canon EOS R6")]], false),
            cmt2: ifdBlock([[0x9003, ascii("2025:01:02 03:04:05")]], false),
          },
          [box("mvhd", new Uint8Array(100))],
        ),
      ),
    );
    expect(exif).toMatchObject({ cameraModel: "Canon EOS R6", dateTimeOriginal: "2025:01:02 03:04:05" });
  });

  it("reads the GPS IFD from CMT4", async () => {
    const exif = await parseExif(
      blobOf(
        cr3({
          cmt1: ifdBlock([[0x0110, ascii("Canon EOS R5")]]),
          cmt4: ifdBlock([
            [0x0001, ascii("N")],
            [0x0002, rational([49, 1], [15, 1], [0, 1])],
            [0x0003, ascii("W")],
            [0x0004, rational([123, 1], [6, 1], [0, 1])],
          ]),
        }),
      ),
    );
    expect(exif.gpsLatitude).toBeCloseTo(49.25, 5);
    expect(exif.gpsLongitude).toBeCloseTo(-123.1, 5);
  });

  it("reads nothing from an ISO media file without Canon's box, or a cut-off one", async () => {
    const ftyp = box("ftyp", latin1("mp42\0\0\0\0mp42"));
    expect(await parseExif(blobOf(concat([ftyp, box("moov", box("mvhd", new Uint8Array(10)))])))).toEqual({});
    const whole = cr3({ cmt1: ifdBlock([[0x0110, ascii("Canon EOS R5")]]) });
    expect(await parseExif(blobOf(whole.slice(0, 60)))).toEqual({});
  });
});
