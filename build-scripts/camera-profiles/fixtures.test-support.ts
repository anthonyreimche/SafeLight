// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Builds TIFF-structured test files (DCPs, DNGs, RAW headers) in memory, so no
// Adobe file goes into the repo.

export interface TiffEntry {
  tag: number;
  type: 1 | 2 | 3 | 4 | 10 | 11;
  values: number[] | string;
}

const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 10: 8, 11: 4 } as const;

function encode(e: TiffEntry, le: boolean): { count: number; bytes: Uint8Array } {
  if (typeof e.values === "string") {
    const bytes = new TextEncoder().encode(`${e.values}\0`);
    return { count: bytes.length, bytes };
  }
  const bytes = new Uint8Array(SIZE[e.type] * e.values.length);
  const view = new DataView(bytes.buffer);
  e.values.forEach((x, i) => {
    if (e.type === 1) view.setUint8(i, x);
    else if (e.type === 3) view.setUint16(i * 2, x, le);
    else if (e.type === 4) view.setUint32(i * 4, x, le);
    else if (e.type === 11) view.setFloat32(i * 4, x, le);
    else {
      view.setInt32(i * 8, Math.round(x * 10000), le);
      view.setInt32(i * 8 + 4, 10000, le);
    }
  });
  return { count: e.values.length, bytes };
}

/** The entries in IFD0 and, with `exif`, a second IFD IFD0 points at through
 *  0x8769. Values over four bytes follow the IFDs. */
export function buildTiff(
  ifd0: TiffEntry[],
  { magic = 42, littleEndian = true, exif }: { magic?: number; littleEndian?: boolean; exif?: TiffEntry[] } = {},
): Uint8Array {
  const le = littleEndian;
  const ifds: TiffEntry[][] = [[...ifd0], ...(exif ? [[...exif]] : [])];
  if (exif) ifds[0].push({ tag: 0x8769, type: 4, values: [0] });
  for (const list of ifds) list.sort((a, b) => a.tag - b.tag);
  const ifdAt: number[] = [];
  let end = 8;
  for (const list of ifds) {
    ifdAt.push(end);
    end += 2 + list.length * 12 + 4;
  }
  const pointer = ifds[0].find((e) => e.tag === 0x8769);
  if (exif && pointer) pointer.values = [ifdAt[1]];
  const encoded = ifds.map((list) => list.map((e) => encode(e, le)));
  const outOfLine = encoded.flat().reduce((n, x) => n + (x.bytes.length > 4 ? x.bytes.length + (x.bytes.length & 1) : 0), 0);
  const out = new Uint8Array(end + outOfLine);
  const view = new DataView(out.buffer);
  out.set(le ? [0x49, 0x49] : [0x4d, 0x4d], 0);
  view.setUint16(2, magic, le);
  view.setUint32(4, 8, le);
  let data = end;
  ifds.forEach((list, k) => {
    view.setUint16(ifdAt[k], list.length, le);
    list.forEach((e, i) => {
      const at = ifdAt[k] + 2 + i * 12;
      const { count, bytes } = encoded[k][i];
      view.setUint16(at, e.tag, le);
      view.setUint16(at + 2, e.type, le);
      view.setUint32(at + 4, count, le);
      if (bytes.length <= 4) out.set(bytes, at + 8);
      else {
        view.setUint32(at + 8, data, le);
        out.set(bytes, data);
        data += bytes.length + (bytes.length & 1);
      }
    });
  });
  return out;
}

export interface DcpFixture {
  model: string;
  name: string;
  /** ProfileEmbedPolicy; null leaves the tag out. Default 0. */
  policy?: number | null;
  copyright?: string;
  /** ColorMatrix1; defaults to COLOR_MATRIX_1, null leaves the tag out. */
  colorMatrix1?: number[] | null;
  /** ForwardMatrix1; defaults to FORWARD_MATRIX_1, null leaves the tag out. */
  forwardMatrix1?: number[] | null;
  toneCurve?: number[];
  look?: { dims: [number, number, number]; data: number[] };
  hueSat?: { dims: [number, number, number]; data1: number[]; data2?: number[] };
  exposureOffset?: number;
  littleEndian?: boolean;
}

export const COLOR_MATRIX_1 = [1.1395, -0.5115, 0.0263, -0.4486, 1.2207, 0.2568, -0.045, 0.1207, 0.8802];
export const FORWARD_MATRIX_1 = [0.7978, 0.1352, 0.0313, 0.288, 0.7119, 0.0001, 0, 0, 0.8251];

/** A single-illuminant DCP (ColorMatrix1, ForwardMatrix1, illuminant D65). */
export function buildDcp(f: DcpFixture): Uint8Array {
  const entries: TiffEntry[] = [
    { tag: 0xc614, type: 2, values: f.model },
    { tag: 0xc6f8, type: 2, values: f.name },
    { tag: 0xc6fe, type: 2, values: f.copyright ?? "Copyright 2018 Adobe Systems, Inc." },
    { tag: 0xc65a, type: 3, values: [21] },
  ];
  if (f.colorMatrix1 !== null) entries.push({ tag: 0xc621, type: 10, values: f.colorMatrix1 ?? COLOR_MATRIX_1 });
  if (f.forwardMatrix1 !== null) entries.push({ tag: 0xc714, type: 10, values: f.forwardMatrix1 ?? FORWARD_MATRIX_1 });
  if (f.policy !== null) entries.push({ tag: 0xc6fd, type: 4, values: [f.policy ?? 0] });
  if (f.toneCurve) entries.push({ tag: 0xc6fc, type: 11, values: f.toneCurve });
  if (f.look) {
    entries.push(
      { tag: 0xc725, type: 4, values: f.look.dims },
      { tag: 0xc726, type: 11, values: f.look.data },
      { tag: 0xc7a4, type: 4, values: [1] },
    );
  }
  if (f.hueSat) {
    entries.push({ tag: 0xc6f9, type: 4, values: f.hueSat.dims }, { tag: 0xc6fa, type: 11, values: f.hueSat.data1 });
    if (f.hueSat.data2) entries.push({ tag: 0xc6fb, type: 11, values: f.hueSat.data2 });
  }
  if (f.exposureOffset !== undefined) {
    entries.push({ tag: 0xc7a5, type: 10, values: [f.exposureOffset] }, { tag: 0xc7a6, type: 4, values: [1] });
  }
  return buildTiff(entries, { magic: 0x4352, littleEndian: f.littleEndian ?? true });
}

export interface DngFixture {
  /** UniqueCameraModel. */
  model: string;
  baselineExposure: number;
  make: string;
  exifModel: string;
  iso?: number;
}

/** A DNG's IFD0 (Make, Model, UniqueCameraModel, BaselineExposure) and, with an ISO, its EXIF IFD. */
export function buildDng(f: DngFixture): Uint8Array {
  return buildTiff(
    [
      { tag: 0x010f, type: 2, values: f.make },
      { tag: 0x0110, type: 2, values: f.exifModel },
      { tag: 0xc614, type: 2, values: f.model },
      { tag: 0xc62a, type: 10, values: [f.baselineExposure] },
    ],
    { exif: f.iso === undefined ? undefined : [{ tag: 0x8827, type: 3, values: [f.iso] }] },
  );
}
