// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The EXIF reader consumes raw camera bytes, so these tests assemble real TIFF
// structures instead of shipping binary fixtures: a small typed builder lays out
// a spec-shaped header, IFD chain and out-of-line value block in either byte
// order. Everything is asserted through the public parseExif / parseXmp /
// parseExifDate surface. Run with `npm test`.

import { describe, it, expect } from "vitest";
import { parseExif, parseExifDate, parseXmp } from "./exif";
import type { ExifData } from "./types";

// ---------------------------------------------------------------------------
// TIFF builder
// ---------------------------------------------------------------------------

// Every buffer here owns its storage; BlobPart rejects the SharedArrayBuffer-
// backed `Uint8Array<ArrayBufferLike>` that the unparameterised alias widens to.
type Bytes = Uint8Array<ArrayBuffer>;

type Ratio = readonly [num: number, den: number];

type Field =
  | { kind: "ascii"; text: string }
  | { kind: "byte"; values: readonly number[] }
  | { kind: "short"; values: readonly number[] }
  | { kind: "long"; values: readonly number[] }
  | { kind: "slong"; values: readonly number[] }
  | { kind: "rational"; values: readonly Ratio[] }
  | { kind: "srational"; values: readonly Ratio[] }
  | { kind: "raw"; type: number; data: Bytes }
  /** Type/count with a hand-picked value-offset — for pointers that go nowhere. */
  | { kind: "pointer"; type: number; count: number; offset: number };

type Entry = readonly [tag: number, field: Field];

interface TiffSpec {
  le: boolean;
  ifd0?: readonly Entry[];
  /** Written as its own IFD; IFD0 gets a generated 0x8769 pointer to it. */
  exif?: readonly Entry[];
  /** Written as its own IFD; IFD0 gets a generated 0x8825 pointer to it. */
  gps?: readonly Entry[];
}

const ascii = (text: string): Field => ({ kind: "ascii", text });
const byte = (...values: number[]): Field => ({ kind: "byte", values });
const short = (...values: number[]): Field => ({ kind: "short", values });
const long = (...values: number[]): Field => ({ kind: "long", values });
const slong = (...values: number[]): Field => ({ kind: "slong", values });
const rational = (...values: Ratio[]): Field => ({ kind: "rational", values });
const srational = (...values: Ratio[]): Field => ({ kind: "srational", values });
const utf8 = (type: number, text: string): Field => ({
  kind: "raw",
  type,
  data: new TextEncoder().encode(text),
});
const pointer = (type: number, count: number, offset: number): Field => ({
  kind: "pointer",
  type,
  count,
  offset,
});

const EXIF_IFD_TAG = 0x8769;
const GPS_IFD_TAG = 0x8825;
const HEADER_BYTES = 8; // order mark (2) + magic 42 (2) + IFD0 offset (4)

const ifdBytes = (entries: number): number => 2 + entries * 12 + 4;
const wordAligned = (n: number): number => n + (n & 1);
const byTag = (entries: readonly Entry[]): Entry[] => [...entries].sort((a, b) => a[0] - b[0]);

function pack(
  values: readonly number[],
  size: number,
  put: (view: DataView, at: number, value: number) => void,
): Bytes {
  const data = new Uint8Array(values.length * size);
  const view = new DataView(data.buffer);
  values.forEach((value, i) => put(view, i * size, value));
  return data;
}

function packRatios(values: readonly Ratio[], le: boolean, signed: boolean): Bytes {
  const data = new Uint8Array(values.length * 8);
  const view = new DataView(data.buffer);
  values.forEach(([num, den], i) => {
    if (signed) {
      view.setInt32(i * 8, num, le);
      view.setInt32(i * 8 + 4, den, le);
    } else {
      view.setUint32(i * 8, num, le);
      view.setUint32(i * 8 + 4, den, le);
    }
  });
  return data;
}

function encode(
  field: Exclude<Field, { kind: "pointer" }>,
  le: boolean,
): { type: number; count: number; data: Bytes } {
  switch (field.kind) {
    case "ascii": {
      const data = new Uint8Array(field.text.length + 1); // TIFF ASCII is NUL-terminated
      for (let i = 0; i < field.text.length; i++) data[i] = field.text.charCodeAt(i);
      return { type: 2, count: data.length, data };
    }
    case "byte":
      return { type: 1, count: field.values.length, data: Uint8Array.from(field.values) };
    case "raw":
      return { type: field.type, count: field.data.length, data: field.data };
    case "short":
      return {
        type: 3,
        count: field.values.length,
        data: pack(field.values, 2, (v, at, n) => v.setUint16(at, n, le)),
      };
    case "long":
      return {
        type: 4,
        count: field.values.length,
        data: pack(field.values, 4, (v, at, n) => v.setUint32(at, n, le)),
      };
    case "slong":
      return {
        type: 9,
        count: field.values.length,
        data: pack(field.values, 4, (v, at, n) => v.setInt32(at, n, le)),
      };
    case "rational":
      return { type: 5, count: field.values.length, data: packRatios(field.values, le, false) };
    case "srational":
      return { type: 10, count: field.values.length, data: packRatios(field.values, le, true) };
  }
}

function writeIfd(
  bytes: Bytes,
  view: DataView,
  at: number,
  entries: readonly Entry[],
  le: boolean,
  cursor: { at: number },
): void {
  view.setUint16(at, entries.length, le);
  let p = at + 2;
  for (const [tag, field] of entries) {
    view.setUint16(p, tag, le);
    if (field.kind === "pointer") {
      view.setUint16(p + 2, field.type, le);
      view.setUint32(p + 4, field.count, le);
      view.setUint32(p + 8, field.offset, le);
      p += 12;
      continue;
    }
    const { type, count, data } = encode(field, le);
    view.setUint16(p + 2, type, le);
    view.setUint32(p + 4, count, le);
    if (data.length <= 4) {
      // Values of 4 bytes or fewer live inline, left-justified in the offset field.
      bytes.set(data, p + 8);
    } else {
      view.setUint32(p + 8, cursor.at, le);
      bytes.set(data, cursor.at);
      cursor.at += wordAligned(data.length);
    }
    p += 12;
  }
  view.setUint32(p, 0, le); // no next IFD
}

function buildTiff(spec: TiffSpec): Bytes {
  const { le } = spec;
  const own0 = spec.ifd0 ?? [];
  const ifd0At = HEADER_BYTES;
  const count0 = own0.length + (spec.exif ? 1 : 0) + (spec.gps ? 1 : 0);
  const exifAt = ifd0At + ifdBytes(count0);
  const gpsAt = exifAt + (spec.exif ? ifdBytes(spec.exif.length) : 0);
  const valuesAt = gpsAt + (spec.gps ? ifdBytes(spec.gps.length) : 0);

  const entries0: Entry[] = [...own0];
  if (spec.exif) entries0.push([EXIF_IFD_TAG, long(exifAt)]);
  if (spec.gps) entries0.push([GPS_IFD_TAG, long(gpsAt)]);

  const ifds = [byTag(entries0)];
  if (spec.exif) ifds.push(byTag(spec.exif));
  if (spec.gps) ifds.push(byTag(spec.gps));

  let total = valuesAt;
  for (const ifd of ifds) {
    for (const [, field] of ifd) {
      if (field.kind === "pointer") continue;
      const { data } = encode(field, le);
      if (data.length > 4) total += wordAligned(data.length);
    }
  }

  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, le ? 0x4949 : 0x4d4d, false);
  view.setUint16(2, 42, le);
  view.setUint32(4, ifd0At, le);

  const cursor = { at: valuesAt };
  // gpsAt collapses onto exifAt when there is no Exif IFD, so this stays aligned.
  const starts = [ifd0At, exifAt, gpsAt];
  ifds.forEach((ifd, i) => writeIfd(bytes, view, starts[i], ifd, le, cursor));
  return bytes;
}

// ---------------------------------------------------------------------------
// JPEG container helpers
// ---------------------------------------------------------------------------

function concat(parts: readonly Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function latin1(s: string): Bytes {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function segment(marker: number, payload: Uint8Array): Bytes {
  const seg = new Uint8Array(4 + payload.length);
  seg[0] = 0xff;
  seg[1] = marker;
  new DataView(seg.buffer).setUint16(2, payload.length + 2, false); // length counts itself
  seg.set(payload, 4);
  return seg;
}

const jpeg = (segments: readonly Uint8Array[]): Bytes =>
  concat([latin1("\xff\xd8"), ...segments, latin1("\xff\xd9")]);

const APP0 = 0xe0;
const APP1 = 0xe1;
const SOS = 0xda;

const jfifPayload = latin1("JFIF\0\x01\x02\0\0\x01\0\x01\0\0");
const exifPayload = (tiff: Uint8Array): Bytes => concat([latin1("Exif\0\0"), tiff]);

const blobOf = (bytes: Bytes): Blob => new Blob([bytes]);
const fromTiff = (spec: TiffSpec): Promise<ExifData> => parseExif(blobOf(buildTiff(spec)));

// ---------------------------------------------------------------------------
// Tags (mirrors the private tables in exif.ts)
// ---------------------------------------------------------------------------

const T = {
  ImageDescription: 0x010e,
  Make: 0x010f,
  Model: 0x0110,
  Orientation: 0x0112,
  Software: 0x0131,
  Artist: 0x013b,
  Xmp: 0x02bc,
  Copyright: 0x8298,
  ExposureTime: 0x829a,
  FNumber: 0x829d,
  ExposureProgram: 0x8822,
  ISO: 0x8827,
  DateTimeOriginal: 0x9003,
  ExposureBias: 0x9204,
  MaxAperture: 0x9205,
  SubjectDistance: 0x9206,
  MeteringMode: 0x9207,
  LightSource: 0x9208,
  Flash: 0x9209,
  FocalLength: 0x920a,
  ColorSpace: 0xa001,
  ExposureMode: 0xa402,
  WhiteBalance: 0xa403,
  FocalLength35mm: 0xa405,
  SceneCaptureType: 0xa406,
  BodySerial: 0xa431,
  LensMake: 0xa433,
  LensModel: 0xa434,
  LensSerial: 0xa435,
  ColorMatrix1: 0xc621,
  ColorMatrix2: 0xc622,
  AsShotNeutral: 0xc628,
  CalibrationIlluminant1: 0xc65a,
  CalibrationIlluminant2: 0xc65b,
} as const;

const G = {
  LatRef: 0x0001,
  Lat: 0x0002,
  LonRef: 0x0003,
  Lon: 0x0004,
  AltRef: 0x0005,
  Alt: 0x0006,
} as const;

// ---------------------------------------------------------------------------
// Byte-order-sensitive decoding
// ---------------------------------------------------------------------------

describe.each([
  { order: "little-endian (II)", le: true },
  { order: "big-endian (MM)", le: false },
])("parseExif — $order", ({ le }) => {
  it("reads IFD0 strings both inline and via the value block", async () => {
    const exif = await fromTiff({
      le,
      ifd0: [
        [T.Make, ascii("AB")], // 3 bytes with the NUL — fits in the offset field
        [T.Model, ascii("EOS R5")], // 7 bytes — IFD holds a pointer instead
        [T.Software, ascii("Safelight 2.5.0")],
        [T.Artist, ascii("Anthony Reimche")],
        [T.Copyright, ascii("(C) 2026")],
        [T.ImageDescription, ascii("  padded  ")],
      ],
    });
    expect(exif.cameraMake).toBe("AB");
    expect(exif.cameraModel).toBe("EOS R5");
    expect(exif.software).toBe("Safelight 2.5.0");
    expect(exif.artist).toBe("Anthony Reimche");
    expect(exif.copyright).toBe("(C) 2026");
    expect(exif.imageDescription).toBe("padded");
  });

  it("drops an ASCII tag that holds only the terminator", async () => {
    const exif = await fromTiff({ le, ifd0: [[T.Make, ascii("")], [T.Model, ascii("X100VI")]] });
    expect(exif.cameraMake).toBeUndefined();
    expect(exif.cameraModel).toBe("X100VI");
  });

  it("reads SHORT, LONG and SLONG integer tags", async () => {
    const exif = await fromTiff({
      le,
      ifd0: [[T.Orientation, short(6)]],
      exif: [
        [T.ISO, short(400)],
        [T.FocalLength35mm, long(35)],
      ],
    });
    expect(exif.orientation).toBe(6);
    expect(exif.iso).toBe(400);
    expect(exif.focalLength35mm).toBe(35);

    const slongIso = await fromTiff({ le, exif: [[T.ISO, slong(6400)]] });
    expect(slongIso.iso).toBe(6400);
  });

  it("follows the Exif sub-IFD pointer and converts its RATIONALs", async () => {
    const exif = await fromTiff({
      le,
      exif: [
        [T.FNumber, rational([71, 10])],
        [T.ExposureTime, rational([1, 250])],
        [T.FocalLength, rational([2350, 100])], // 23.5 mm — reported as a whole number
        [T.ExposureBias, srational([-1, 3])],
        [T.MaxAperture, rational([300, 100])], // APEX 3 -> f/2.8
        [T.SubjectDistance, rational([355, 100])],
        [T.DateTimeOriginal, ascii("2026:07:26 14:30:05")],
        [T.LensModel, ascii("RF 50mm F1.2 L USM")],
        [T.LensMake, ascii("Canon")],
        [T.LensSerial, ascii("LS-0001")],
        [T.BodySerial, ascii("BS-0002")],
      ],
    });
    expect(exif.aperture).toBe(7.1);
    expect(exif.shutterSpeed).toBe("1/250");
    expect(exif.focalLength).toBe(24);
    expect(exif.exposureCompensation).toBe(-0.33);
    expect(exif.maxAperture).toBe(2.8);
    expect(exif.subjectDistance).toBe(3.55);
    expect(exif.dateTimeOriginal).toBe("2026:07:26 14:30:05");
    expect(exif.lens).toBe("RF 50mm F1.2 L USM");
    expect(exif.lensMake).toBe("Canon");
    expect(exif.lensSerial).toBe("LS-0001");
    expect(exif.bodySerial).toBe("BS-0002");
  });

  it("reads the GPS sub-IFD and applies the hemisphere and altitude refs", async () => {
    const exif = await fromTiff({
      le,
      gps: [
        [G.LatRef, ascii("N")],
        [G.Lat, rational([37, 1], [48, 1], [30, 1])],
        [G.LonRef, ascii("W")],
        [G.Lon, rational([122, 1], [16, 1], [0, 1])],
        [G.AltRef, byte(1)], // 1 = below sea level
        [G.Alt, rational([1234, 100])],
      ],
    });
    expect(exif.gpsLatitude).toBe(37.808333);
    expect(exif.gpsLongitude).toBe(-122.266667);
    expect(exif.gpsAltitude).toBe(-12.3);
  });

  it("treats a missing hemisphere ref as north/east and altitude ref 0 as above sea level", async () => {
    const exif = await fromTiff({
      le,
      gps: [
        [G.Lat, rational([10, 1], [30, 1], [0, 1])],
        [G.Lon, rational([20, 1], [0, 1], [0, 1])],
        [G.AltRef, byte(0)],
        [G.Alt, rational([100, 1])],
      ],
    });
    expect(exif.gpsLatitude).toBe(10.5);
    expect(exif.gpsLongitude).toBe(20);
    expect(exif.gpsAltitude).toBe(100);
  });

  it("ignores a GPS coordinate with fewer than three RATIONALs", async () => {
    const exif = await fromTiff({
      le,
      gps: [
        [G.LatRef, ascii("N")],
        [G.Lat, rational([37, 1], [48, 1])],
      ],
    });
    expect(exif.gpsLatitude).toBeUndefined();
  });

  it("estimates colour temperature from DNG AsShotNeutral without a colour matrix", async () => {
    const kelvin = async (r: number, g: number, b: number): Promise<number | undefined> =>
      (
        await fromTiff({
          le,
          ifd0: [[T.AsShotNeutral, rational([r, 10000], [g, 10000], [b, 10000])]],
        })
      ).colorTemperature;

    // An equal-channel neutral means unity WB gains, i.e. the 6500 K reference.
    expect(await kelvin(10000, 10000, 10000)).toBeCloseTo(6500, -2);
    // Red-heavy neutral = red-rich light = tungsten/warm-white.
    expect(await kelvin(9000, 5000, 3000)).toBeLessThan(4000);
    // Blue-heavy neutral = blue-rich light = shade/overcast.
    expect(await kelvin(5000, 5500, 6200)).toBeGreaterThan(7000);
  });

  it("ignores AsShotNeutral with a zero channel or fewer than three values", async () => {
    const zeroed = await fromTiff({
      le,
      ifd0: [[T.AsShotNeutral, rational([1, 1], [0, 1], [1, 1])]],
    });
    expect(zeroed.colorTemperature).toBeUndefined();

    const short2 = await fromTiff({ le, ifd0: [[T.AsShotNeutral, rational([1, 1], [1, 1])]] });
    expect(short2.colorTemperature).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// DNG colour temperature
// ---------------------------------------------------------------------------

// LibRaw's `adobe_coeff` table (src/tables/colordata.cpp, "All matrices are from
// Adobe DNG Converter"), which carries each body's ColorMatrix2 — the D65
// XYZ->camera matrix — scaled by 10000.
const CANON_1D_MK3_D65 = [6291, -540, -976, -8350, 16145, 2311, -1714, 1858, 7326];
const CANON_40D_D65 = [6071, -747, -856, -7653, 15365, 2441, -2025, 2553, 7315];

// sRGB's XYZ->RGB matrix (IEC 61966-2-1). A camera calibrated with it is, by
// definition, an sRGB device, so its neutral chromaticities are exactly D65's.
const SRGB_D65 = [32406, -15372, -4986, -9689, 18758, 415, 557, -2040, 10570];

const colorMatrix = (coefficients: readonly number[]): Field =>
  srational(...coefficients.map((c): Ratio => [c, 10000]));

// A Canon daylight AsShotNeutral: WB multipliers of roughly (2.10, 1.0, 1.35).
const DAYLIGHT_NEUTRAL = rational([4759, 10000], [10000, 10000], [7422, 10000]);
const UNITY_NEUTRAL = rational([1, 1], [1, 1], [1, 1]);

const D65 = 21;
const STANDARD_LIGHT_A = 17;

const temperatureOf = async (ifd0: readonly Entry[]): Promise<number | undefined> =>
  (await fromTiff({ le: true, ifd0 })).colorTemperature;

describe("parseExif — DNG colour temperature", () => {
  it("reads a real daylight neutral as a daylight temperature", async () => {
    expect(
      await temperatureOf([
        [T.AsShotNeutral, DAYLIGHT_NEUTRAL],
        [T.ColorMatrix2, colorMatrix(CANON_1D_MK3_D65)],
        [T.CalibrationIlluminant2, short(D65)],
      ]),
    ).toBe(5430);
  });

  it("puts an sRGB-calibrated unity neutral on the D65 white point", async () => {
    expect(
      await temperatureOf([
        [T.AsShotNeutral, UNITY_NEUTRAL],
        [T.ColorMatrix1, colorMatrix(SRGB_D65)],
        [T.CalibrationIlluminant1, short(D65)],
      ]),
    ).toBe(6500);
  });

  it("orders the neutrals it is given", async () => {
    const withMatrix = async (r: number, b: number): Promise<number | undefined> =>
      temperatureOf([
        [T.AsShotNeutral, rational([r, 10000], [10000, 10000], [b, 10000])],
        [T.ColorMatrix2, colorMatrix(CANON_1D_MK3_D65)],
        [T.CalibrationIlluminant2, short(D65)],
      ]);
    const tungsten = await withMatrix(6600, 4600);
    const daylight = await withMatrix(4759, 7422);
    const shade = await withMatrix(4200, 8800);
    expect(tungsten).toBeLessThan(3500);
    expect(daylight!).toBeGreaterThan(tungsten!);
    expect(shade!).toBeGreaterThan(daylight!);
  });

  it("interpolates between two calibrations by reciprocal temperature", async () => {
    // Pairing sRGB's matrix with a Canon body is synthetic — it exists to give
    // the two calibrations endpoints far enough apart to tell a blend from a pick.
    const tungstenOnly = await temperatureOf([
      [T.AsShotNeutral, DAYLIGHT_NEUTRAL],
      [T.ColorMatrix1, colorMatrix(SRGB_D65)],
      [T.CalibrationIlluminant1, short(STANDARD_LIGHT_A)],
    ]);
    const daylightOnly = await temperatureOf([
      [T.AsShotNeutral, DAYLIGHT_NEUTRAL],
      [T.ColorMatrix2, colorMatrix(CANON_1D_MK3_D65)],
      [T.CalibrationIlluminant2, short(D65)],
    ]);
    const blended = await temperatureOf([
      [T.AsShotNeutral, DAYLIGHT_NEUTRAL],
      [T.ColorMatrix1, colorMatrix(SRGB_D65)],
      [T.CalibrationIlluminant1, short(STANDARD_LIGHT_A)],
      [T.ColorMatrix2, colorMatrix(CANON_1D_MK3_D65)],
      [T.CalibrationIlluminant2, short(D65)],
    ]);
    expect(blended!).toBeGreaterThan(Math.min(tungstenOnly!, daylightOnly!));
    expect(blended!).toBeLessThan(Math.max(tungstenOnly!, daylightOnly!));
  });

  it("ignores the illuminant pair when both calibrations share a matrix", async () => {
    const single = await temperatureOf([
      [T.AsShotNeutral, DAYLIGHT_NEUTRAL],
      [T.ColorMatrix1, colorMatrix(CANON_1D_MK3_D65)],
      [T.CalibrationIlluminant1, short(D65)],
    ]);
    const duplicated = await temperatureOf([
      [T.AsShotNeutral, DAYLIGHT_NEUTRAL],
      [T.ColorMatrix1, colorMatrix(CANON_1D_MK3_D65)],
      [T.CalibrationIlluminant1, short(STANDARD_LIGHT_A)],
      [T.ColorMatrix2, colorMatrix(CANON_1D_MK3_D65)],
      [T.CalibrationIlluminant2, short(D65)],
    ]);
    expect(duplicated).toBe(single);
  });

  it("falls back to the first matrix when the pair cannot be interpolated", async () => {
    const first = await temperatureOf([
      [T.AsShotNeutral, DAYLIGHT_NEUTRAL],
      [T.ColorMatrix1, colorMatrix(CANON_40D_D65)],
      [T.CalibrationIlluminant1, short(D65)],
    ]);
    // No CalibrationIlluminant2 at all.
    expect(
      await temperatureOf([
        [T.AsShotNeutral, DAYLIGHT_NEUTRAL],
        [T.ColorMatrix1, colorMatrix(CANON_40D_D65)],
        [T.CalibrationIlluminant1, short(D65)],
        [T.ColorMatrix2, colorMatrix(CANON_1D_MK3_D65)],
      ]),
    ).toBe(first);
    // Illuminant 255 ("other") carries no temperature.
    expect(
      await temperatureOf([
        [T.AsShotNeutral, DAYLIGHT_NEUTRAL],
        [T.ColorMatrix1, colorMatrix(CANON_40D_D65)],
        [T.CalibrationIlluminant1, short(D65)],
        [T.ColorMatrix2, colorMatrix(CANON_1D_MK3_D65)],
        [T.CalibrationIlluminant2, short(255)],
      ]),
    ).toBe(first);
    // Both calibrated at the same temperature — nothing to interpolate across.
    expect(
      await temperatureOf([
        [T.AsShotNeutral, DAYLIGHT_NEUTRAL],
        [T.ColorMatrix1, colorMatrix(CANON_40D_D65)],
        [T.CalibrationIlluminant1, short(D65)],
        [T.ColorMatrix2, colorMatrix(CANON_1D_MK3_D65)],
        [T.CalibrationIlluminant2, short(D65)],
      ]),
    ).toBe(first);
  });

  it("falls back to the blackbody estimate on an unusable matrix", async () => {
    const noMatrix = await temperatureOf([[T.AsShotNeutral, DAYLIGHT_NEUTRAL]]);
    expect(noMatrix).toBeDefined();

    // Singular: row 3 is the sum of rows 1 and 2, so the matrix cannot be inverted.
    expect(
      await temperatureOf([
        [T.AsShotNeutral, DAYLIGHT_NEUTRAL],
        [T.ColorMatrix1, colorMatrix([10000, 0, 0, 0, 10000, 0, 10000, 10000, 0])],
        [T.CalibrationIlluminant1, short(D65)],
      ]),
    ).toBe(noMatrix);

    // A four-colour body writes a 4×3 matrix, which this 3×3 path cannot use.
    expect(
      await temperatureOf([
        [T.AsShotNeutral, DAYLIGHT_NEUTRAL],
        [T.ColorMatrix1, colorMatrix([...CANON_1D_MK3_D65, 1000, 1000, 1000])],
        [T.CalibrationIlluminant1, short(D65)],
      ]),
    ).toBe(noMatrix);
  });

  it("reports nothing when the neutral maps outside the slider's range", async () => {
    // A near-degenerate neutral pushes the solved chromaticity off the locus.
    expect(
      await temperatureOf([
        [T.AsShotNeutral, rational([1, 10000], [10000, 10000], [9999, 10000])],
        [T.ColorMatrix2, colorMatrix(CANON_1D_MK3_D65)],
        [T.CalibrationIlluminant2, short(D65)],
      ]),
    ).toBeUndefined();
  });
});

describe("parseExif — byte order equivalence", () => {
  const spec = (le: boolean): TiffSpec => ({
    le,
    ifd0: [
      [T.Make, ascii("Canon")],
      [T.Model, ascii("EOS R5")],
      [T.Orientation, short(8)],
      [T.AsShotNeutral, rational([5200, 10000], [10000, 10000], [7600, 10000])],
    ],
    exif: [
      [T.FNumber, rational([28, 10])],
      [T.ExposureTime, rational([1, 640])],
      [T.ISO, short(1600)],
      [T.ExposureBias, srational([-2, 3])],
      [T.Flash, short(0x19)],
    ],
    gps: [
      [G.LatRef, ascii("S")],
      [G.Lat, rational([33, 1], [51, 1], [54, 1])],
    ],
  });

  it("decodes II and MM encodings of the same file identically", async () => {
    const ii = await parseExif(blobOf(buildTiff(spec(true))));
    const mm = await parseExif(blobOf(buildTiff(spec(false))));
    expect(ii.cameraModel).toBe("EOS R5");
    expect(ii.gpsLatitude).toBeLessThan(0);
    expect(ii.colorTemperature).toBeGreaterThan(6500);
    expect(mm).toEqual(ii);
  });
});

// ---------------------------------------------------------------------------
// Value formatting (byte-order independent — exercised little-endian only)
// ---------------------------------------------------------------------------

const withExifIfd = (entries: readonly Entry[]): Promise<ExifData> =>
  fromTiff({ le: true, exif: entries });

describe("parseExif — shutter formatting", () => {
  it("renders sub-second times as a reciprocal and long times in seconds", async () => {
    expect((await withExifIfd([[T.ExposureTime, rational([1, 8000])]])).shutterSpeed).toBe("1/8000");
    expect((await withExifIfd([[T.ExposureTime, rational([1, 1])]])).shutterSpeed).toBe("1s");
    expect((await withExifIfd([[T.ExposureTime, rational([15, 10])]])).shutterSpeed).toBe("1.5s");
    expect((await withExifIfd([[T.ExposureTime, rational([30, 1])]])).shutterSpeed).toBe("30s");
  });

  it("emits an empty string for a zero exposure time", async () => {
    expect((await withExifIfd([[T.ExposureTime, rational([0, 1])]])).shutterSpeed).toBe("");
  });
});

describe("parseExif — enumerated fields", () => {
  it("maps exposure program, metering mode, exposure mode and scene type", async () => {
    const exif = await withExifIfd([
      [T.ExposureProgram, short(3)],
      [T.MeteringMode, short(5)],
      [T.ExposureMode, short(2)],
      [T.SceneCaptureType, short(1)],
    ]);
    expect(exif.exposureProgram).toBe("Aperture priority");
    expect(exif.meteringMode).toBe("Multi-segment");
    expect(exif.exposureMode).toBe("Auto bracket");
    expect(exif.sceneCaptureType).toBe("Landscape");
  });

  it("omits enum fields whose value is not in the lookup table", async () => {
    const exif = await withExifIfd([
      [T.ExposureProgram, short(99)],
      [T.MeteringMode, short(255)],
      [T.SceneCaptureType, short(9)],
      [T.ColorSpace, short(7)],
    ]);
    expect(exif.exposureProgram).toBeUndefined();
    expect(exif.meteringMode).toBeUndefined();
    expect(exif.sceneCaptureType).toBeUndefined();
    expect(exif.colorSpace).toBeUndefined();
  });

  it("maps the colour space values including the Uncalibrated sentinel", async () => {
    expect((await withExifIfd([[T.ColorSpace, short(1)]])).colorSpace).toBe("sRGB");
    expect((await withExifIfd([[T.ColorSpace, short(2)]])).colorSpace).toBe("Adobe RGB");
    expect((await withExifIfd([[T.ColorSpace, short(65535)]])).colorSpace).toBe("Uncalibrated");
  });

  it("decodes the flash bitfield into fired state plus mode", async () => {
    const flash = async (bits: number): Promise<string | undefined> =>
      (await withExifIfd([[T.Flash, short(bits)]])).flash;
    expect(await flash(0x00)).toBe("Did not fire");
    expect(await flash(0x01)).toBe("Fired");
    expect(await flash(0x08)).toBe("On, did not fire");
    expect(await flash(0x09)).toBe("On, fired");
    expect(await flash(0x10)).toBe("Off");
    expect(await flash(0x18)).toBe("Auto, did not fire");
    expect(await flash(0x19)).toBe("Auto, fired");
  });

  it("prefers a named LightSource over the WhiteBalance auto/manual flag", async () => {
    const named = await withExifIfd([[T.LightSource, short(21)], [T.WhiteBalance, short(0)]]);
    expect(named.whiteBalance).toBe("D65");

    // LightSource 0 is "unknown" and has no entry, so WhiteBalance takes over.
    const auto = await withExifIfd([[T.LightSource, short(0)], [T.WhiteBalance, short(0)]]);
    expect(auto.whiteBalance).toBe("Auto");
    expect((await withExifIfd([[T.WhiteBalance, short(1)]])).whiteBalance).toBe("Manual");
    expect((await withExifIfd([[T.WhiteBalance, short(2)]])).whiteBalance).toBeUndefined();
    expect((await withExifIfd([[T.ISO, short(100)]])).whiteBalance).toBeUndefined();
  });
});

describe("parseExif — numeric guards", () => {
  it("rejects subject distances at the unknown/infinity sentinels", async () => {
    expect((await withExifIfd([[T.SubjectDistance, rational([0, 1])]])).subjectDistance).toBeUndefined();
    expect(
      (await withExifIfd([[T.SubjectDistance, rational([65535, 1])]])).subjectDistance,
    ).toBeUndefined();
  });

  it("drops a 35 mm equivalent focal length of zero", async () => {
    expect((await withExifIfd([[T.FocalLength35mm, short(0)]])).focalLength35mm).toBeUndefined();
    expect((await withExifIfd([[T.FocalLength35mm, short(75)]])).focalLength35mm).toBe(75);
  });

  it("ignores a RATIONAL with a zero denominator but keeps its siblings", async () => {
    const exif = await withExifIfd([[T.FNumber, rational([71, 0])], [T.ISO, short(100)]]);
    expect(exif.aperture).toBeUndefined();
    expect(exif.iso).toBe(100);
  });

  it("ignores a tag whose declared type does not match the reader's expectation", async () => {
    // FNumber is a RATIONAL; a SHORT-typed one is not silently coerced.
    const exif = await withExifIfd([[T.FNumber, short(28)], [T.ISO, short(200)]]);
    expect(exif.aperture).toBeUndefined();
    expect(exif.iso).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Container detection
// ---------------------------------------------------------------------------

describe("parseExif — container detection", () => {
  const tiff = buildTiff({ le: true, ifd0: [[T.Make, ascii("Nikon")]] });

  it("finds the Exif APP1 after a JFIF APP0 segment", async () => {
    const bytes = jpeg([segment(APP0, jfifPayload), segment(APP1, exifPayload(tiff))]);
    expect((await parseExif(blobOf(bytes))).cameraMake).toBe("Nikon");
  });

  it("resolves IFD pointers relative to the TIFF header, not the file", async () => {
    // Pointers inside the APP1 are TIFF-relative; the Model needs a value block,
    // so it only resolves if the reader adds the segment's base offset.
    const nested = buildTiff({
      le: true,
      ifd0: [[T.Model, ascii("Z 8")]],
      exif: [[T.LensModel, ascii("NIKKOR Z 24-70mm f/2.8 S")]],
    });
    const bytes = jpeg([segment(APP0, jfifPayload), segment(APP1, exifPayload(nested))]);
    const exif = await parseExif(blobOf(bytes));
    expect(exif.cameraModel).toBe("Z 8");
    expect(exif.lens).toBe("NIKKOR Z 24-70mm f/2.8 S");
  });

  it("returns nothing for a JPEG whose only APP1 is not an Exif segment", async () => {
    const bytes = jpeg([segment(APP1, latin1("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>"))]);
    expect(await parseExif(blobOf(bytes))).toEqual({});
  });

  it("stops scanning at the start-of-scan marker", async () => {
    const bytes = jpeg([segment(SOS, latin1("scan")), segment(APP1, exifPayload(tiff))]);
    expect(await parseExif(blobOf(bytes))).toEqual({});
  });

  it("returns nothing for a buffer too short to hold a header", async () => {
    expect(await parseExif(blobOf(latin1("II")))).toEqual({});
    expect(await parseExif(blobOf(new Uint8Array(0)))).toEqual({});
  });

  it("returns nothing for an unrecognised container", async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(await parseExif(blobOf(png))).toEqual({});
  });

  it("returns nothing when the TIFF version word is not 42", async () => {
    const bogus = buildTiff({ le: true, ifd0: [[T.Make, ascii("Nikon")]] });
    new DataView(bogus.buffer).setUint16(2, 43, true);
    expect(await parseExif(blobOf(bogus))).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Malformed structures — the parser's contract is "never throw, skip the junk"
// ---------------------------------------------------------------------------

describe("parseExif — malformed structures", () => {
  it("stops at the buffer end when the IFD entry count overruns it", async () => {
    // Every field here is inline, so the buffer ends immediately after IFD0.
    const bytes = buildTiff({
      le: true,
      ifd0: [[T.Make, ascii("AB")], [T.Orientation, short(3)], [T.Software, ascii("Xy")]],
    });
    new DataView(bytes.buffer).setUint16(HEADER_BYTES, 500, true); // IFD0 entry count
    const exif = await parseExif(blobOf(bytes));
    expect(exif.cameraMake).toBe("AB");
    expect(exif.orientation).toBe(3);
    expect(exif.software).toBe("Xy");
  });

  it("ignores an entry whose value pointer lies outside the buffer", async () => {
    const exif = await fromTiff({
      le: true,
      ifd0: [[T.Make, pointer(2, 64, 0x7fff)], [T.Model, ascii("EOS R5")]],
    });
    expect(exif.cameraMake).toBeUndefined();
    expect(exif.cameraModel).toBe("EOS R5");
  });

  it("ignores an out-of-range Exif IFD pointer and keeps the IFD0 tags", async () => {
    const exif = await fromTiff({
      le: true,
      ifd0: [[T.Make, ascii("Canon")], [EXIF_IFD_TAG, long(0xfffff)]],
    });
    expect(exif.cameraMake).toBe("Canon");
    expect(exif.iso).toBeUndefined();
  });

  it("survives truncation part-way through IFD0", async () => {
    const bytes = buildTiff({ le: true, ifd0: [[T.Make, ascii("Canon")]] });
    expect(await parseExif(blobOf(bytes.slice(0, 3)))).toEqual({});
    expect(await parseExif(blobOf(bytes.slice(0, 12)))).toEqual({});
  });

  it("keeps inline tags when the trailing value block is cut off", async () => {
    const bytes = buildTiff({
      le: true,
      ifd0: [[T.Orientation, short(6)], [T.Make, ascii("AB")], [T.Model, ascii("EOS R5")]],
    });
    // Model is the only out-of-line value; its block is the last 8 bytes.
    const exif = await parseExif(blobOf(bytes.slice(0, bytes.length - 8)));
    expect(exif.orientation).toBe(6);
    expect(exif.cameraMake).toBe("AB");
    expect(exif.cameraModel).toBeUndefined();
  });

  it("returns nothing for random bytes that happen to start with a byte-order mark", async () => {
    const junk = new Uint8Array(64);
    junk[0] = 0x49;
    junk[1] = 0x49;
    for (let i = 2; i < junk.length; i++) junk[i] = (i * 37) & 0xff;
    expect(await parseExif(blobOf(junk))).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// parseExifDate
// ---------------------------------------------------------------------------

describe("parseExifDate", () => {
  it("converts an EXIF timestamp using the local timezone", () => {
    expect(parseExifDate("2026:07:26 14:30:05")).toBe(
      new Date(2026, 6, 26, 14, 30, 5).getTime(),
    );
  });

  it("accepts the ISO-style 'T' separator and trailing sub-seconds", () => {
    const expected = new Date(2026, 0, 2, 3, 4, 5).getTime();
    expect(parseExifDate("2026:01:02T03:04:05")).toBe(expected);
    expect(parseExifDate("2026:01:02 03:04:05.250")).toBe(expected);
  });

  it("returns undefined for absent, empty or non-matching input", () => {
    expect(parseExifDate(undefined)).toBeUndefined();
    expect(parseExifDate("")).toBeUndefined();
    expect(parseExifDate("2026-07-26 14:30:05")).toBeUndefined(); // dashes, not colons
    expect(parseExifDate("2026:07:26")).toBeUndefined(); // no time part
    expect(parseExifDate("0000:00:00 00:00:00 ")).not.toBeUndefined();
  });

  it("does not range-check the components — out-of-range values roll over", () => {
    expect(parseExifDate("2026:13:26 14:30:05")).toBe(new Date(2027, 0, 26, 14, 30, 5).getTime());
  });
});

// ---------------------------------------------------------------------------
// parseXmp
// ---------------------------------------------------------------------------

const XMP_JPEG_SIG = "http://ns.adobe.com/xap/1.0/\0";

function xmpPacket(body: string, attrs = ""): string {
  return (
    `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/">` +
    `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    `<rdf:Description rdf:about=""` +
    ` xmlns:xmp="http://ns.adobe.com/xap/1.0/"` +
    ` xmlns:dc="http://purl.org/dc/elements/1.1/"${attrs}>` +
    `${body}</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`
  );
}

const xmpTiff = (le: boolean, body: string, attrs = ""): Bytes =>
  buildTiff({ le, ifd0: [[T.Xmp, utf8(1, xmpPacket(body, attrs))]] });

const xmpJpeg = (body: string): Bytes =>
  jpeg([
    segment(APP1, concat([latin1(XMP_JPEG_SIG), new TextEncoder().encode(xmpPacket(body))])),
  ]);

const bagOf = (tag: string, ...items: string[]): string =>
  `<${tag}><rdf:Bag>${items.map((i) => `<rdf:li>${i}</rdf:li>`).join("")}</rdf:Bag></${tag}>`;

describe("parseXmp", () => {
  const body =
    `<xmp:Rating>3</xmp:Rating><xmp:Label>Red</xmp:Label>` +
    bagOf("dc:subject", "sunset", "Ben &amp; Jerry") +
    `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Golden hour</rdf:li></rdf:Alt></dc:title>`;

  it("reads rating, label, keywords and title from a TIFF XMP tag in either byte order", async () => {
    const expected = {
      rating: 3,
      colorLabel: "Red",
      keywords: ["sunset", "Ben & Jerry"],
      title: "Golden hour",
    };
    expect(await parseXmp(blobOf(xmpTiff(true, body)))).toEqual(expected);
    expect(await parseXmp(blobOf(xmpTiff(false, body)))).toEqual(expected);
  });

  it("reads the same properties from a JPEG XMP APP1 segment", async () => {
    const xmp = await parseXmp(blobOf(xmpJpeg(body)));
    expect(xmp.rating).toBe(3);
    expect(xmp.keywords).toEqual(["sunset", "Ben & Jerry"]);
  });

  it("reads properties serialised as rdf:Description attributes", async () => {
    const xmp = await parseXmp(blobOf(xmpTiff(true, "", ` xmp:Rating="4" xmp:Label="Blue"`)));
    expect(xmp.rating).toBe(4);
    expect(xmp.colorLabel).toBe("Blue");
  });

  it("does not confuse xmp:Rating with the longer xmp:RatingPercent", async () => {
    const elements = `<xmp:RatingPercent>80</xmp:RatingPercent><xmp:Rating>2</xmp:Rating>`;
    expect((await parseXmp(blobOf(xmpTiff(true, elements)))).rating).toBe(2);

    const attrs = ` xmp:RatingPercent="80" xmp:Rating="1"`;
    expect((await parseXmp(blobOf(xmpTiff(true, "", attrs)))).rating).toBe(1);
  });

  it("keeps a zero rating, rounds fractional ones and rejects out-of-range ones", async () => {
    const rating = async (v: string): Promise<number | undefined> =>
      (await parseXmp(blobOf(xmpTiff(true, `<xmp:Rating>${v}</xmp:Rating>`)))).rating;
    expect(await rating("0")).toBe(0);
    expect(await rating("3.6")).toBe(4);
    expect(await rating("6")).toBeUndefined();
    expect(await rating("-1")).toBeUndefined();
    expect(await rating("unrated")).toBeUndefined();
  });

  it("omits keywords when the rdf:Bag is empty", async () => {
    const xmp = await parseXmp(blobOf(xmpTiff(true, bagOf("dc:subject"))));
    expect(xmp.keywords).toBeUndefined();
  });

  it("returns nothing when the file carries no XMP packet", async () => {
    const plain = buildTiff({ le: true, ifd0: [[T.Make, ascii("Canon")]] });
    expect(await parseXmp(blobOf(plain))).toEqual({});
    expect(await parseXmp(blobOf(jpeg([segment(APP0, jfifPayload)])))).toEqual({});
    expect(await parseXmp(blobOf(latin1("II")))).toEqual({});
    expect(await parseXmp(blobOf(Uint8Array.from([0x89, 0x50, 0x4e, 0x47])))).toEqual({});
  });

  it("returns nothing when the XMP value pointer lies outside the buffer", async () => {
    const bytes = buildTiff({ le: true, ifd0: [[T.Xmp, pointer(1, 128, 0x7000)]] });
    expect(await parseXmp(blobOf(bytes))).toEqual({});
  });
});
