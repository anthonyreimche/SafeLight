// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import {
  TEMPERATURE_MAX_K,
  TEMPERATURE_MIN_K,
  kelvinFromWhiteBalanceGains,
} from "@/rendering/blackbody";
import type { ExifData } from "./types";

// Lightweight, dependency-free EXIF reader. Handles JPEG (Exif APP1) and
// TIFF-based formats including RAW (NEF, DNG, CR2, ARW). We only read the tags
// the app surfaces; everything else is ignored. All parsing stays client-side.

const MAX_BYTES = 1 << 20; // 1 MiB — EXIF/MakerNotes sit near the file start.

// TIFF field type -> byte size.
const TYPE_SIZE: Record<number, number> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  7: 1, // UNDEFINED
  9: 4, // SLONG
  10: 8, // SRATIONAL
};

const TAG = {
  ImageDescription: 0x010e,
  Make: 0x010f,
  Model: 0x0110,
  Orientation: 0x0112,
  Software: 0x0131,
  DateTime: 0x0132,
  Artist: 0x013b,
  Copyright: 0x8298,
  ExifIFD: 0x8769,
  GPSIFD: 0x8825,
  MakerNote: 0x927c,
  PixelXDimension: 0xa002,
  PixelYDimension: 0xa003,
  InteropIFD: 0xa005,
  MsPadding: 0xea1c,
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

const GPS_TAG = {
  LatitudeRef: 0x0001,
  Latitude: 0x0002,
  LongitudeRef: 0x0003,
  Longitude: 0x0004,
  AltitudeRef: 0x0005,
  Altitude: 0x0006,
} as const;

interface Reader {
  view: DataView;
  base: number; // byte offset of the TIFF header within the buffer
  le: boolean; // little-endian
}

interface Entry {
  type: number;
  count: number;
  valueOffset: number; // offset of the inline value / value-pointer field
}

export async function parseExif(blob: Blob): Promise<ExifData> {
  try {
    const slice = blob.size > MAX_BYTES ? blob.slice(0, MAX_BYTES) : blob;
    const view = new DataView(await slice.arrayBuffer());
    const base = findTiffStart(view);
    if (base < 0) return {};
    return parseTiff(view, base);
  } catch {
    return {};
  }
}

// Convert an EXIF "YYYY:MM:DD HH:MM:SS" string to an epoch millisecond value.
export function parseExifDate(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = s.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, se] = m;
  const t = new Date(+y, +mo - 1, +d, +h, +mi, +se).getTime();
  return Number.isNaN(t) ? undefined : t;
}

// ---------------------------------------------------------------------------
// Raw-entry harvest for export
//
// parseExif above interprets tags for display; exports instead need the source
// file's entries back intact so they can be re-serialized into the exported
// image (see modules/export/exif-write). Only entries that survive relocation
// are returned: IFD0 by whitelist (its remaining tags describe the source
// raster — strips, tiles, sub-IFDs, thumbnails), the Exif IFD by blocklist
// (MakerNotes and the Interop pointer embed source-file offsets; colour space
// and pixel dimensions are rewritten by the export), the GPS IFD wholesale.
// Value bytes are normalised to little-endian so the writer needs no
// byte-order handling.
// ---------------------------------------------------------------------------

export interface RawExifEntry {
  tag: number;
  /** TIFF field type (1 BYTE, 2 ASCII, 3 SHORT, 4 LONG, 5 RATIONAL, …). */
  type: number;
  count: number;
  /** Value bytes, little-endian regardless of the source file's byte order. */
  value: Uint8Array;
}

export interface RawExifIfds {
  ifd0: RawExifEntry[];
  exif: RawExifEntry[];
  gps: RawExifEntry[];
}

const IFD0_HARVEST = new Set<number>([
  TAG.ImageDescription,
  TAG.Make,
  TAG.Model,
  TAG.DateTime,
  TAG.Artist,
  TAG.Copyright,
]);

const EXIF_HARVEST_SKIP = new Set<number>([
  TAG.MakerNote,
  TAG.InteropIFD,
  TAG.ColorSpace,
  TAG.PixelXDimension,
  TAG.PixelYDimension,
  TAG.MsPadding,
]);

const HARVEST_MAX_VALUE = 8 << 10; // sanity cap; no relocatable tag is bigger

export async function readExifEntries(blob: Blob): Promise<RawExifIfds | null> {
  try {
    const slice = blob.size > MAX_BYTES ? blob.slice(0, MAX_BYTES) : blob;
    const view = new DataView(await slice.arrayBuffer());
    const base = findTiffStart(view);
    if (base < 0) return null;
    const le = view.getUint16(base, false) === 0x4949;
    if (view.getUint16(base + 2, le) !== 42) return null;
    const r: Reader = { view, base, le };
    const ifd0Map = readIFD(r, view.getUint32(base + 4, le));
    const sub = (ptr: Entry | undefined): Map<number, Entry> => {
      const off = numTag(r, ptr);
      return off === undefined ? new Map() : readIFD(r, off);
    };
    const ifd0 = harvestEntries(r, ifd0Map, (tag) => IFD0_HARVEST.has(tag));
    const exif = harvestEntries(r, sub(ifd0Map.get(TAG.ExifIFD)), (tag) => !EXIF_HARVEST_SKIP.has(tag));
    const gps = harvestEntries(r, sub(ifd0Map.get(TAG.GPSIFD)), () => true);
    return ifd0.length || exif.length || gps.length ? { ifd0, exif, gps } : null;
  } catch {
    return null;
  }
}

function harvestEntries(
  r: Reader,
  entries: Map<number, Entry>,
  keep: (tag: number) => boolean,
): RawExifEntry[] {
  const out: RawExifEntry[] = [];
  for (const [tag, e] of entries) {
    if (!keep(tag)) continue;
    const value = valueBytesLE(r, e);
    if (value) out.push({ tag, type: e.type, count: e.count, value });
  }
  return out;
}

function valueBytesLE(r: Reader, e: Entry): Uint8Array | null {
  const unit = TYPE_SIZE[e.type];
  if (!unit) return null;
  const size = unit * e.count;
  if (size === 0 || size > HARVEST_MAX_VALUE) return null;
  const at = dataOffset(r, e);
  if (at < 0 || at + size > r.view.byteLength) return null;
  const out = new Uint8Array(size);
  // Word width for byte swapping: SHORT is 2, the LONG-based types 4 (a
  // RATIONAL is two LONG words). Byte-granular types copy verbatim.
  const word = unit === 1 ? 1 : e.type === 3 ? 2 : 4;
  if (word === 1 || r.le) {
    for (let i = 0; i < size; i++) out[i] = r.view.getUint8(at + i);
  } else {
    for (let i = 0; i < size; i += word) {
      for (let k = 0; k < word; k++) out[i + k] = r.view.getUint8(at + i + (word - 1 - k));
    }
  }
  return out;
}

// XMP photo metadata (star rating, colour label, keywords, title). Cameras and
// editing apps write these into an XMP packet rather than EXIF tags — Nikon
// stores the in-camera star rating here, which is what Windows Explorer shows.
// We read the packet (TIFF/RAW tag 0x02bc, or a JPEG XMP APP1 segment) and pull
// out the handful of fields the catalog tracks.
export interface XmpData {
  rating?: number; // 0..5 stars
  colorLabel?: string; // raw label string, e.g. "Red"
  keywords?: string[];
  title?: string;
}

const XMP_TAG = 0x02bc; // TIFF IFD0 tag carrying the XMP packet
const XMP_JPEG_SIG = "http://ns.adobe.com/xap/1.0/\0"; // JPEG XMP APP1 header

export async function parseXmp(blob: Blob): Promise<XmpData> {
  try {
    const slice = blob.size > MAX_BYTES ? blob.slice(0, MAX_BYTES) : blob;
    const view = new DataView(await slice.arrayBuffer());
    const text = extractXmpText(view);
    return text ? parseXmpText(text) : {};
  } catch {
    return {};
  }
}

function extractXmpText(view: DataView): string | null {
  if (view.byteLength < 4) return null;
  const head = view.getUint16(0, false);
  if (head === 0xffd8) return extractXmpFromJpeg(view);
  if (head === 0x4949 || head === 0x4d4d) return extractXmpFromTiff(view);
  return null;
}

function extractXmpFromTiff(view: DataView): string | null {
  const le = view.getUint16(0, false) === 0x4949;
  if (view.getUint16(2, le) !== 42) return null;
  const r: Reader = { view, base: 0, le };
  const ifd0 = readIFD(r, view.getUint32(4, le));
  const e = ifd0.get(XMP_TAG);
  if (!e) return null;
  const start = dataOffset(r, e);
  if (start < 0 || start >= view.byteLength) return null;
  return decodeUtf8(view, start, Math.min(start + e.count, view.byteLength));
}

function extractXmpFromJpeg(view: DataView): string | null {
  let off = 2;
  while (off + 4 <= view.byteLength) {
    if (view.getUint8(off) !== 0xff) break;
    const marker = view.getUint8(off + 1);
    if (marker === 0xda || marker === 0xd9) break; // SOS / EOI -> no more metadata
    const len = view.getUint16(off + 2, false);
    const segStart = off + 4;
    if (marker === 0xe1 && matchAscii(view, segStart, XMP_JPEG_SIG)) {
      const textStart = segStart + XMP_JPEG_SIG.length;
      return decodeUtf8(view, textStart, Math.min(off + 2 + len, view.byteLength));
    }
    off += 2 + len;
  }
  return null;
}

function matchAscii(view: DataView, at: number, sig: string): boolean {
  if (at + sig.length > view.byteLength) return false;
  for (let i = 0; i < sig.length; i++) {
    if (view.getUint8(at + i) !== sig.charCodeAt(i)) return false;
  }
  return true;
}

function decodeUtf8(view: DataView, start: number, end: number): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset + start, end - start);
  return new TextDecoder("utf-8").decode(bytes);
}

function parseXmpText(xmp: string): XmpData {
  const out: XmpData = {};
  const rating = xmpValue(xmp, "xmp:Rating");
  if (rating !== undefined) {
    const n = Math.round(Number(rating));
    if (Number.isFinite(n) && n >= 0 && n <= 5) out.rating = n;
  }
  const label = xmpValue(xmp, "xmp:Label");
  if (label) out.colorLabel = label;
  const title = rdfBagItems(xmp, "dc:title")[0];
  if (title) out.title = title;
  const keywords = rdfBagItems(xmp, "dc:subject");
  if (keywords.length) out.keywords = keywords;
  return out;
}

// An XMP property is serialised either as an element (<xmp:Rating>1</xmp:Rating>)
// or as an attribute on rdf:Description (xmp:Rating="1") — handle both forms. The
// `(?:\s[^>]*)?>` opener requires the tag to end at a space or '>', so a name
// that's a prefix of another (xmp:Rating vs xmp:RatingPercent) doesn't collide.
function xmpValue(xmp: string, tag: string): string | undefined {
  const el = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`).exec(xmp);
  if (el) return decodeEntities(el[1].trim());
  const attr = new RegExp(`\\s${tag}="([^"]*)"`).exec(xmp);
  if (attr) return decodeEntities(attr[1].trim());
  return undefined;
}

// dc:subject (keywords) and dc:title are rdf:Bag / rdf:Alt containers of
// rdf:li entries.
function rdfBagItems(xmp: string, tag: string): string[] {
  const block = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xmp);
  if (!block) return [];
  const items: string[] = [];
  const re = /<rdf:li(?:\s[^>]*)?>([\s\S]*?)<\/rdf:li>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block[1]))) {
    const v = decodeEntities(m[1].trim());
    if (v) items.push(v);
  }
  return items;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function findTiffStart(view: DataView): number {
  if (view.byteLength < 4) return -1;
  const head = view.getUint16(0, false);

  // JPEG: walk APP segments looking for the Exif APP1.
  if (head === 0xffd8) {
    let off = 2;
    while (off + 4 <= view.byteLength) {
      if (view.getUint8(off) !== 0xff) break;
      const marker = view.getUint8(off + 1);
      if (marker === 0xda || marker === 0xd9) break; // SOS / EOI -> no more metadata
      const len = view.getUint16(off + 2, false);
      if (marker === 0xe1) {
        const sig = off + 4;
        if (
          sig + 6 <= view.byteLength &&
          view.getUint32(sig, false) === 0x45786966 && // "Exif"
          view.getUint16(sig + 4, false) === 0x0000
        ) {
          return sig + 6; // TIFF header begins right after "Exif\0\0"
        }
      }
      off += 2 + len;
    }
    return -1;
  }

  // TIFF / TIFF-based RAW: header is at byte 0.
  if (head === 0x4949 || head === 0x4d4d) return 0;
  return -1;
}

function parseTiff(view: DataView, base: number): ExifData {
  const le = view.getUint16(base, false) === 0x4949;
  if (view.getUint16(base + 2, le) !== 42) return {}; // TIFF magic
  const r: Reader = { view, base, le };

  const exif: ExifData = {};
  const ifd0 = readIFD(r, view.getUint32(base + 4, le));

  const desc = asciiTag(r, ifd0.get(TAG.ImageDescription));
  if (desc) exif.imageDescription = desc;
  const make = asciiTag(r, ifd0.get(TAG.Make));
  if (make) exif.cameraMake = make;
  const model = asciiTag(r, ifd0.get(TAG.Model));
  if (model) exif.cameraModel = model;
  const software = asciiTag(r, ifd0.get(TAG.Software));
  if (software) exif.software = software;
  const artist = asciiTag(r, ifd0.get(TAG.Artist));
  if (artist) exif.artist = artist;
  const copyright = asciiTag(r, ifd0.get(TAG.Copyright));
  if (copyright) exif.copyright = copyright;

  const orientation = numTag(r, ifd0.get(TAG.Orientation));
  if (orientation !== undefined) exif.orientation = orientation;

  const exifPtr = numTag(r, ifd0.get(TAG.ExifIFD));
  if (exifPtr !== undefined) {
    const e = readIFD(r, exifPtr);

    const fnumber = ratTag(r, e.get(TAG.FNumber));
    if (fnumber !== undefined) exif.aperture = round(fnumber, 1);

    const focal = ratTag(r, e.get(TAG.FocalLength));
    if (focal !== undefined) exif.focalLength = Math.round(focal);

    const focal35 = numTag(r, e.get(TAG.FocalLength35mm));
    if (focal35 !== undefined && focal35 > 0) exif.focalLength35mm = focal35;

    const iso = numTag(r, e.get(TAG.ISO));
    if (iso !== undefined) exif.iso = iso;

    const exposure = ratTag(r, e.get(TAG.ExposureTime));
    if (exposure !== undefined) exif.shutterSpeed = formatShutter(exposure);

    const bias = ratTag(r, e.get(TAG.ExposureBias));
    if (bias !== undefined) exif.exposureCompensation = round(bias, 2);

    const program = numTag(r, e.get(TAG.ExposureProgram));
    if (program !== undefined) exif.exposureProgram = formatExposureProgram(program);

    const metering = numTag(r, e.get(TAG.MeteringMode));
    if (metering !== undefined) exif.meteringMode = formatMeteringMode(metering);

    const wb = resolveWhiteBalance(
      numTag(r, e.get(TAG.LightSource)),
      numTag(r, e.get(TAG.WhiteBalance)),
    );
    if (wb) exif.whiteBalance = wb;

    const flash = numTag(r, e.get(TAG.Flash));
    if (flash !== undefined) exif.flash = formatFlash(flash);

    const date = asciiTag(r, e.get(TAG.DateTimeOriginal));
    if (date) exif.dateTimeOriginal = date;

    const maxAp = ratTag(r, e.get(TAG.MaxAperture));
    if (maxAp !== undefined) exif.maxAperture = round(Math.pow(Math.SQRT2, maxAp), 1);

    const subDist = ratTag(r, e.get(TAG.SubjectDistance));
    if (subDist !== undefined && subDist > 0 && subDist < 65535) exif.subjectDistance = round(subDist, 2);

    const colorSpace = numTag(r, e.get(TAG.ColorSpace));
    if (colorSpace !== undefined) exif.colorSpace = formatColorSpace(colorSpace);

    const expMode = numTag(r, e.get(TAG.ExposureMode));
    if (expMode !== undefined) exif.exposureMode = formatExposureMode(expMode);

    const scene = numTag(r, e.get(TAG.SceneCaptureType));
    if (scene !== undefined) exif.sceneCaptureType = formatSceneCaptureType(scene);

    const bodySerial = asciiTag(r, e.get(TAG.BodySerial));
    if (bodySerial) exif.bodySerial = bodySerial;
    const lensMake = asciiTag(r, e.get(TAG.LensMake));
    if (lensMake) exif.lensMake = lensMake;
    const lens = asciiTag(r, e.get(TAG.LensModel));
    if (lens) exif.lens = lens;
    const lensSerial = asciiTag(r, e.get(TAG.LensSerial));
    if (lensSerial) exif.lensSerial = lensSerial;
  }

  const gpsPtr = numTag(r, ifd0.get(TAG.GPSIFD));
  if (gpsPtr !== undefined) {
    const g = readIFD(r, gpsPtr);
    const lat = parseGpsCoord(r, g.get(GPS_TAG.Latitude), g.get(GPS_TAG.LatitudeRef));
    const lon = parseGpsCoord(r, g.get(GPS_TAG.Longitude), g.get(GPS_TAG.LongitudeRef));
    if (lat !== undefined) exif.gpsLatitude = lat;
    if (lon !== undefined) exif.gpsLongitude = lon;
    const altEntry = g.get(GPS_TAG.Altitude);
    if (altEntry) {
      let alt = ratTag(r, altEntry);
      if (alt !== undefined) {
        const altRef = numTagByte(r, g.get(GPS_TAG.AltitudeRef));
        if (altRef === 1) alt = -alt;
        exif.gpsAltitude = round(alt, 1);
      }
    }
  }

  // DNG AsShotNeutral — sits in IFD0, gives per-channel neutral values.
  const asnEntry = ifd0.get(TAG.AsShotNeutral);
  if (asnEntry) {
    const asn = readRationals(r, asnEntry);
    if (asn.length >= 3 && asn[0] > 0 && asn[1] > 0 && asn[2] > 0) {
      const neutral: Vec3 = [asn[0], asn[1], asn[2]];
      const kelvin =
        cctFromCameraNeutral(neutral, readCalibrations(r, ifd0)) ??
        kelvinFromWhiteBalanceGains(1 / neutral[0], 1 / neutral[1], 1 / neutral[2]);
      if (kelvin !== undefined && kelvin >= TEMPERATURE_MIN_K && kelvin <= TEMPERATURE_MAX_K) {
        exif.colorTemperature = kelvin;
      }
    }
  }

  return exif;
}

// Read an array of RATIONAL or SRATIONAL values as numbers.
function readRationals(r: Reader, e: Entry): number[] {
  if (e.type !== 5 && e.type !== 10) return [];
  const signed = e.type === 10;
  const sz = 8;
  const start = dataOffset(r, e);
  const out: number[] = [];
  for (let i = 0; i < e.count; i++) {
    const off = start + i * sz;
    if (off + sz > r.view.byteLength) break;
    const num = signed ? r.view.getInt32(off, r.le) : r.view.getUint32(off, r.le);
    const den = signed ? r.view.getInt32(off + 4, r.le) : r.view.getUint32(off + 4, r.le);
    out.push(den === 0 ? 0 : num / den);
  }
  return out;
}

// ---------------------------------------------------------------------------
// DNG colour temperature
//
// AsShotNeutral is expressed in the camera's own raw space, so its channel
// ratios say nothing about Kelvin until they are carried into XYZ through the
// camera's colour matrix. The DNG colour-calibration tags carry that matrix —
// up to two of them, each tied to a calibration illuminant — and the pair is
// interpolated by temperature, which is the value we are solving for. Hence the
// fixed point below: guess a chromaticity, build the matrix its temperature
// selects, map the neutral through it, and repeat until the guess stops moving.
// ---------------------------------------------------------------------------

type Vec3 = readonly [number, number, number];
// Row-major 3×3. The nine-element length is gated where the tag is read, which
// is the only place a matrix enters this file.
type Matrix3 = readonly number[];

interface Calibration {
  matrix: Matrix3; // XYZ (D50) -> camera raw
  kelvin: number; // calibration illuminant, 0 when unrecognised
}

// EXIF LightSource codes -> Kelvin, following dng_sdk's
// dng_camera_profile::IlluminantToTemperature. Fluorescent entries are the
// midpoint of the range the standard gives them. Codes outside this table
// (including 0 "unknown" and 255 "other") leave the matrix uninterpolatable.
const ILLUMINANT_KELVIN: Record<number, number> = {
  1: 5500, // Daylight
  2: 4200, // Fluorescent
  3: 2850, // Tungsten
  4: 5500, // Flash
  9: 5500, // Fine weather
  10: 6500, // Cloudy weather
  11: 7500, // Shade
  12: 6400, // Daylight fluorescent
  13: 5000, // Day white fluorescent
  14: 4200, // Cool white fluorescent
  15: 3450, // White fluorescent
  17: 2850, // Standard light A
  18: 5500, // Standard light B
  19: 6500, // Standard light C
  20: 5500, // D55
  21: 6500, // D65
  22: 7500, // D75
  23: 5000, // D50
  24: 3200, // ISO studio tungsten
};

// Seed for the fixed point — the DNG spec's own reference white.
const D50_XY: readonly [number, number] = [0.3457, 0.3585];
const CCT_PASSES = 30;
const CCT_EPSILON = 1e-7;

function readCalibrations(r: Reader, ifd0: Map<number, Entry>): Calibration[] {
  const pairs: Array<[number, number]> = [
    [TAG.ColorMatrix1, TAG.CalibrationIlluminant1],
    [TAG.ColorMatrix2, TAG.CalibrationIlluminant2],
  ];
  const out: Calibration[] = [];
  for (const [matrixTag, illuminantTag] of pairs) {
    const entry = ifd0.get(matrixTag);
    if (!entry) continue;
    const matrix = readRationals(r, entry);
    // 9 values = a 3-colour camera. 4-colour bodies write 12 and their neutral
    // has four channels, which this 3×3 path cannot represent.
    if (matrix.length !== 9) continue;
    out.push({ matrix, kelvin: ILLUMINANT_KELVIN[numTag(r, ifd0.get(illuminantTag)) ?? 0] ?? 0 });
  }
  return out;
}

// Correlated colour temperature of an xy chromaticity — McCamy's cubic
// approximation, within a few Kelvin across the range cameras calibrate over.
function cctFromXy(x: number, y: number): number {
  const n = (x - 0.332) / (0.1858 - y);
  return ((449 * n + 3525) * n + 6823.3) * n + 5520.33;
}

function invert3(m: Matrix3): Matrix3 | undefined {
  const [a, b, c, d, e, f, g, h, i] = m;
  const c0 = e * i - f * h;
  const c1 = f * g - d * i;
  const c2 = d * h - e * g;
  const det = a * c0 + b * c1 + c * c2;
  if (!isFinite(det) || Math.abs(det) < 1e-12) return undefined;
  const s = 1 / det;
  return [
    c0 * s, (c * h - b * i) * s, (b * f - c * e) * s,
    c1 * s, (a * i - c * g) * s, (c * d - a * f) * s,
    c2 * s, (b * g - a * h) * s, (a * e - b * d) * s,
  ];
}

function apply3(m: Matrix3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

// The XYZ->camera matrix for a given white point. Two calibrations are blended
// in reciprocal-Kelvin space (the DNG spec's rule); anything else — one matrix,
// an unrecognised illuminant, or two calibrations sharing a temperature — uses
// the first matrix as written.
function xyzToCamera(calibrations: readonly Calibration[], kelvin: number): Matrix3 {
  if (calibrations.length < 2) return calibrations[0].matrix;
  const [low, high] = [...calibrations].sort((a, b) => a.kelvin - b.kelvin);
  if (!low.kelvin || !high.kelvin || low.kelvin === high.kelvin) return calibrations[0].matrix;
  if (kelvin <= low.kelvin) return low.matrix;
  if (kelvin >= high.kelvin) return high.matrix;
  const w = (1 / kelvin - 1 / high.kelvin) / (1 / low.kelvin - 1 / high.kelvin);
  return low.matrix.map((v, i) => w * v + (1 - w) * high.matrix[i]);
}

/**
 * True correlated colour temperature of a camera-space neutral, or undefined
 * when the DNG calibration tags are absent or unusable (singular matrix, a
 * neutral that maps outside the visible cone). Rounded to the 10 K the
 * temperature slider steps in.
 */
function cctFromCameraNeutral(
  neutral: Vec3,
  calibrations: readonly Calibration[],
): number | undefined {
  if (calibrations.length === 0) return undefined;
  let [x, y] = D50_XY;
  for (let pass = 0; pass < CCT_PASSES; pass++) {
    const inverse = invert3(xyzToCamera(calibrations, cctFromXy(x, y)));
    if (!inverse) return undefined;
    const [X, Y, Z] = apply3(inverse, neutral);
    const sum = X + Y + Z;
    if (!(sum > 0) || !isFinite(sum)) return undefined;
    const nextX = X / sum;
    const nextY = Y / sum;
    const settled = Math.abs(nextX - x) + Math.abs(nextY - y) < CCT_EPSILON;
    x = nextX;
    y = nextY;
    if (settled) break;
  }
  const kelvin = cctFromXy(x, y);
  return isFinite(kelvin) ? Math.round(kelvin / 10) * 10 : undefined;
}

function readIFD(r: Reader, ifdOffset: number): Map<number, Entry> {
  const map = new Map<number, Entry>();
  const { view, base, le } = r;
  const at = base + ifdOffset;
  if (at < 0 || at + 2 > view.byteLength) return map;
  const count = view.getUint16(at, le);
  let p = at + 2;
  for (let i = 0; i < count; i++) {
    if (p + 12 > view.byteLength) break;
    const tag = view.getUint16(p, le);
    map.set(tag, {
      type: view.getUint16(p + 2, le),
      count: view.getUint32(p + 4, le),
      valueOffset: p + 8,
    });
    p += 12;
  }
  return map;
}

// Absolute buffer offset where an entry's data lives (inline when it fits in
// the 4-byte field, otherwise a TIFF-relative pointer).
function dataOffset(r: Reader, e: Entry): number {
  const size = (TYPE_SIZE[e.type] ?? 1) * e.count;
  return size <= 4 ? e.valueOffset : r.base + r.view.getUint32(e.valueOffset, r.le);
}

function asciiTag(r: Reader, e: Entry | undefined): string | undefined {
  if (!e || e.type !== 2) return undefined;
  const start = dataOffset(r, e);
  const end = start + e.count;
  if (start < 0 || end > r.view.byteLength) return undefined;
  let s = "";
  for (let i = start; i < end; i++) {
    const c = r.view.getUint8(i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s.trim() || undefined;
}

function numTag(r: Reader, e: Entry | undefined): number | undefined {
  if (!e) return undefined;
  const off = dataOffset(r, e);
  if (off < 0 || off + (TYPE_SIZE[e.type] ?? 0) > r.view.byteLength) return undefined;
  switch (e.type) {
    case 3:
      return r.view.getUint16(off, r.le);
    case 4:
      return r.view.getUint32(off, r.le);
    case 9:
      return r.view.getInt32(off, r.le);
    default:
      return undefined;
  }
}

function ratTag(r: Reader, e: Entry | undefined): number | undefined {
  if (!e || (e.type !== 5 && e.type !== 10)) return undefined;
  const off = dataOffset(r, e);
  if (off < 0 || off + 8 > r.view.byteLength) return undefined;
  const signed = e.type === 10;
  const num = signed ? r.view.getInt32(off, r.le) : r.view.getUint32(off, r.le);
  const den = signed
    ? r.view.getInt32(off + 4, r.le)
    : r.view.getUint32(off + 4, r.le);
  return den === 0 ? undefined : num / den;
}

function numTagByte(r: Reader, e: Entry | undefined): number | undefined {
  if (!e || e.type !== 1) return undefined;
  const off = dataOffset(r, e);
  if (off < 0 || off >= r.view.byteLength) return undefined;
  return r.view.getUint8(off);
}

function parseGpsCoord(
  r: Reader,
  coordEntry: Entry | undefined,
  refEntry: Entry | undefined,
): number | undefined {
  if (!coordEntry) return undefined;
  const parts = readRationals(r, coordEntry);
  if (parts.length < 3) return undefined;
  let deg = parts[0] + parts[1] / 60 + parts[2] / 3600;
  const ref = asciiTag(r, refEntry);
  if (ref === "S" || ref === "W") deg = -deg;
  return round(deg, 6);
}

const EXPOSURE_PROGRAM: Record<number, string> = {
  1: "Manual",
  2: "Program",
  3: "Aperture priority",
  4: "Shutter priority",
  5: "Creative",
  6: "Action",
  7: "Portrait",
  8: "Landscape",
};

function formatExposureProgram(v: number): string | undefined {
  return EXPOSURE_PROGRAM[v];
}

const METERING_MODE: Record<number, string> = {
  1: "Average",
  2: "Center-weighted",
  3: "Spot",
  4: "Multi-spot",
  5: "Multi-segment",
  6: "Partial",
};

function formatMeteringMode(v: number): string | undefined {
  return METERING_MODE[v];
}

const LIGHT_SOURCE: Record<number, string> = {
  1: "Daylight",
  2: "Fluorescent",
  3: "Tungsten",
  4: "Flash",
  9: "Fine weather",
  10: "Cloudy",
  11: "Shade",
  12: "Daylight fluorescent",
  13: "Day white fluorescent",
  14: "Cool white fluorescent",
  15: "White fluorescent",
  17: "Standard light A",
  18: "Standard light B",
  19: "Standard light C",
  20: "D55",
  21: "D65",
  22: "D75",
  23: "D50",
  24: "ISO studio tungsten",
};

function resolveWhiteBalance(
  lightSource: number | undefined,
  whiteBalance: number | undefined,
): string | undefined {
  if (lightSource !== undefined && LIGHT_SOURCE[lightSource]) return LIGHT_SOURCE[lightSource];
  if (whiteBalance === 0) return "Auto";
  if (whiteBalance === 1) return "Manual";
  return undefined;
}

function formatColorSpace(v: number): string | undefined {
  if (v === 1) return "sRGB";
  if (v === 2) return "Adobe RGB";
  if (v === 65535) return "Uncalibrated";
  return undefined;
}

const EXPOSURE_MODE: Record<number, string> = {
  0: "Auto",
  1: "Manual",
  2: "Auto bracket",
};

function formatExposureMode(v: number): string | undefined {
  return EXPOSURE_MODE[v];
}

const SCENE_CAPTURE: Record<number, string> = {
  0: "Standard",
  1: "Landscape",
  2: "Portrait",
  3: "Night",
};

function formatSceneCaptureType(v: number): string | undefined {
  return SCENE_CAPTURE[v];
}

function formatFlash(v: number): string {
  const fired = (v & 1) !== 0;
  const mode = (v >> 3) & 3; // 0=unknown, 1=compulsory, 2=suppressed, 3=auto
  if (mode === 3) return fired ? "Auto, fired" : "Auto, did not fire";
  if (mode === 2) return "Off";
  if (mode === 1) return fired ? "On, fired" : "On, did not fire";
  return fired ? "Fired" : "Did not fire";
}

function formatShutter(t: number): string {
  if (t <= 0) return "";
  if (t >= 1) return `${round(t, 1)}s`;
  return `1/${Math.round(1 / t)}`;
}

function round(v: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}
