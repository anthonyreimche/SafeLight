// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Test fixture builder: assembles spec-shaped TIFF structures (header, IFD
// chain, out-of-line value block, either byte order) and minimal JPEG
// containers, so the EXIF reader/writer tests work from real camera-file
// layouts instead of binary fixtures. Imported only from *.test.ts files.

// Every buffer here owns its storage; BlobPart rejects the SharedArrayBuffer-
// backed `Uint8Array<ArrayBufferLike>` that the unparameterised alias widens to.
export type Bytes = Uint8Array<ArrayBuffer>;

export type Ratio = readonly [num: number, den: number];

export type Field =
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

export type Entry = readonly [tag: number, field: Field];

export interface TiffSpec {
  le: boolean;
  ifd0?: readonly Entry[];
  /** Written as its own IFD; IFD0 gets a generated 0x8769 pointer to it. */
  exif?: readonly Entry[];
  /** Written as its own IFD; IFD0 gets a generated 0x8825 pointer to it. */
  gps?: readonly Entry[];
}

export const ascii = (text: string): Field => ({ kind: "ascii", text });
export const byte = (...values: number[]): Field => ({ kind: "byte", values });
export const short = (...values: number[]): Field => ({ kind: "short", values });
export const long = (...values: number[]): Field => ({ kind: "long", values });
export const slong = (...values: number[]): Field => ({ kind: "slong", values });
export const rational = (...values: Ratio[]): Field => ({ kind: "rational", values });
export const srational = (...values: Ratio[]): Field => ({ kind: "srational", values });
export const utf8 = (type: number, text: string): Field => ({
  kind: "raw",
  type,
  data: new TextEncoder().encode(text),
});
export const pointer = (type: number, count: number, offset: number): Field => ({
  kind: "pointer",
  type,
  count,
  offset,
});

export const EXIF_IFD_TAG = 0x8769;
export const GPS_IFD_TAG = 0x8825;
export const HEADER_BYTES = 8; // order mark (2) + magic 42 (2) + IFD0 offset (4)

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

export function buildTiff(spec: TiffSpec): Bytes {
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

export function concat(parts: readonly Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function latin1(s: string): Bytes {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function segment(marker: number, payload: Uint8Array): Bytes {
  const seg = new Uint8Array(4 + payload.length);
  seg[0] = 0xff;
  seg[1] = marker;
  new DataView(seg.buffer).setUint16(2, payload.length + 2, false); // length counts itself
  seg.set(payload, 4);
  return seg;
}

export const jpeg = (segments: readonly Uint8Array[]): Bytes =>
  concat([latin1("\xff\xd8"), ...segments, latin1("\xff\xd9")]);

export const APP0 = 0xe0;
export const APP1 = 0xe1;
export const APP2 = 0xe2;
export const SOS = 0xda;

export const jfifPayload = latin1("JFIF\0\x01\x02\0\0\x01\0\x01\0\0");
export const exifPayload = (tiff: Uint8Array): Bytes => concat([latin1("Exif\0\0"), tiff]);

export const blobOf = (bytes: Bytes): Blob => new Blob([bytes]);
