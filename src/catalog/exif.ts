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
  Make: 0x010f,
  Model: 0x0110,
  Orientation: 0x0112,
  ExifIFD: 0x8769,
  ExposureTime: 0x829a,
  FNumber: 0x829d,
  ISO: 0x8827,
  DateTimeOriginal: 0x9003,
  FocalLength: 0x920a,
  LensModel: 0xa434,
  AsShotNeutral: 0xc628,
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

  const make = asciiTag(r, ifd0.get(TAG.Make));
  if (make) exif.cameraMake = make;
  const model = asciiTag(r, ifd0.get(TAG.Model));
  if (model) exif.cameraModel = model;

  const orientation = numTag(r, ifd0.get(TAG.Orientation));
  if (orientation !== undefined) exif.orientation = orientation;

  const exifPtr = numTag(r, ifd0.get(TAG.ExifIFD));
  if (exifPtr !== undefined) {
    const e = readIFD(r, exifPtr);

    const fnumber = ratTag(r, e.get(TAG.FNumber));
    if (fnumber !== undefined) exif.aperture = round(fnumber, 1);

    const focal = ratTag(r, e.get(TAG.FocalLength));
    if (focal !== undefined) exif.focalLength = Math.round(focal);

    const iso = numTag(r, e.get(TAG.ISO));
    if (iso !== undefined) exif.iso = iso;

    const exposure = ratTag(r, e.get(TAG.ExposureTime));
    if (exposure !== undefined) exif.shutterSpeed = formatShutter(exposure);

    const date = asciiTag(r, e.get(TAG.DateTimeOriginal));
    if (date) exif.dateTimeOriginal = date;

    const lens = asciiTag(r, e.get(TAG.LensModel));
    if (lens) exif.lens = lens;
  }

  // DNG AsShotNeutral — sits in IFD0, gives per-channel neutral values.
  const asnEntry = ifd0.get(TAG.AsShotNeutral);
  if (asnEntry) {
    const asn = readRationals(r, asnEntry);
    if (asn.length >= 3 && asn[0] > 0 && asn[1] > 0 && asn[2] > 0) {
      const kelvin = estimateKelvinFromNeutral(asn[0], asn[1], asn[2]);
      if (kelvin >= 2000 && kelvin <= 50000) exif.colorTemperature = kelvin;
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

// Estimate Kelvin colour temperature from AsShotNeutral (per-channel neutral
// values). The WB gain is 1/neutral; we look for the Kelvin whose blackbody
// R/B ratio best matches the gain R/B ratio, using Tanner Helland's fit
// (same as the rendering shader).
function estimateKelvinFromNeutral(nR: number, nG: number, nB: number): number {
  // WB gains — green-normalised
  const gR = (1 / nR) / (1 / nG);
  const gB = (1 / nB) / (1 / nG);
  const targetLogRB = Math.log(gR / gB);

  let bestK = 6500;
  let bestErr = Infinity;
  const steps = 240;
  for (let i = 0; i <= steps; i++) {
    const logK = Math.log(2000) + (i / steps) * (Math.log(50000) - Math.log(2000));
    const k = Math.exp(logK);
    const bb = blackbodySrgb(k);
    const ref = blackbodySrgb(6500);
    const rGain = ref[0] / bb[0];
    const bGain = ref[2] / bb[2];
    const err = Math.abs(Math.log(rGain / bGain) - targetLogRB);
    if (err < bestErr) { bestErr = err; bestK = k; }
  }
  return Math.round(bestK / 10) * 10;
}

// Tanner Helland's blackbody → sRGB approximation (matches the shader).
function blackbodySrgb(kelvin: number): [number, number, number] {
  const t = Math.max(1000, Math.min(50000, kelvin)) / 100;
  let r: number, g: number, b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  return [
    Math.max(0, Math.min(255, r)),
    Math.max(0, Math.min(255, g)),
    Math.max(0, Math.min(255, b)),
  ];
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

function formatShutter(t: number): string {
  if (t <= 0) return "";
  if (t >= 1) return `${round(t, 1)}s`;
  return `1/${Math.round(1 / t)}`;
}

function round(v: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}
