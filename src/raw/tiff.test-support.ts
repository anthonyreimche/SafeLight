// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Synthetic TIFF builder for RAW-container tests: lays out IFDs, value heaps,
// SubIFD links and the next-IFD chain from a declarative spec.

import { TIFF_TAG } from "./tiff";

export const TYPE = {
  BYTE: 1,
  ASCII: 2,
  SHORT: 3,
  LONG: 4,
  RATIONAL: 5,
  SBYTE: 6,
  UNDEFINED: 7,
  SSHORT: 8,
  SLONG: 9,
  SRATIONAL: 10,
  FLOAT: 11,
  DOUBLE: 12,
} as const;

const UNIT_SIZE: Record<number, number> = {
  1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8,
};

export interface Field {
  tag: number;
  type: number;
  /** RATIONAL/SRATIONAL hold flattened numerator/denominator pairs. */
  values: number[];
}

export interface IfdSpec {
  fields: Field[];
  /** Spec indices to link through a SubIFDs (0x014a) field. */
  subIfds?: number[];
  /** Spec index to link through the next-IFD pointer. */
  next?: number;
}

export const field = (tag: number, type: number, ...values: number[]): Field => ({
  tag,
  type,
  values,
});

export const asciiField = (tag: number, text: string): Field => ({
  tag,
  type: TYPE.ASCII,
  values: [...text].map((c) => c.charCodeAt(0)).concat(0),
});

const countOf = (f: Field): number =>
  f.type === TYPE.RATIONAL || f.type === TYPE.SRATIONAL ? f.values.length / 2 : f.values.length;

const byteLen = (f: Field): number => countOf(f) * UNIT_SIZE[f.type];

function writeValues(view: DataView, at: number, f: Field, le: boolean): void {
  let p = at;
  for (const v of f.values) {
    switch (f.type) {
      case TYPE.BYTE:
      case TYPE.ASCII:
      case TYPE.UNDEFINED:
        view.setUint8(p, v);
        p += 1;
        break;
      case TYPE.SBYTE:
        view.setInt8(p, v);
        p += 1;
        break;
      case TYPE.SHORT:
        view.setUint16(p, v, le);
        p += 2;
        break;
      case TYPE.SSHORT:
        view.setInt16(p, v, le);
        p += 2;
        break;
      case TYPE.LONG:
      case TYPE.RATIONAL:
        view.setUint32(p, v, le);
        p += 4;
        break;
      case TYPE.SLONG:
      case TYPE.SRATIONAL:
        view.setInt32(p, v, le);
        p += 4;
        break;
      case TYPE.FLOAT:
        view.setFloat32(p, v, le);
        p += 4;
        break;
      case TYPE.DOUBLE:
        view.setFloat64(p, v, le);
        p += 8;
        break;
      default:
        throw new Error(`test builder cannot write TIFF type ${f.type}`);
    }
  }
}

/**
 * Lay out a TIFF: header, then each IFD followed by its own value heap. Every
 * stored offset is relative to `base`, matching how TIFF pointers work when the
 * header is embedded (e.g. inside a JPEG APP1 segment). A `trailer` is appended
 * after the last heap and its offset returned, so a test can point strip
 * offsets at pixel data it laid out itself.
 */
export function buildTiff(
  specs: IfdSpec[],
  opts: { littleEndian?: boolean; base?: number } = {},
): ArrayBuffer {
  return buildTiffWithTrailer(specs, opts).buffer;
}

export function buildTiffWithTrailer(
  specs: IfdSpec[],
  opts: { littleEndian?: boolean; base?: number; trailer?: Uint8Array } = {},
): { buffer: ArrayBuffer; trailerOffset: number } {
  const le = opts.littleEndian ?? true;
  const base = opts.base ?? 0;
  const entryCount = (s: IfdSpec): number => s.fields.length + (s.subIfds ? 1 : 0);

  const ifdAt: number[] = [];
  const heapAt: number[] = [];
  let pos = base + 8;
  for (const s of specs) {
    ifdAt.push(pos);
    pos += 2 + 12 * entryCount(s) + 4;
    heapAt.push(pos);
    for (const f of s.fields) if (byteLen(f) > 4) pos += byteLen(f);
    if (s.subIfds && s.subIfds.length > 1) pos += s.subIfds.length * 4;
  }
  const trailerOffset = pos;
  pos += opts.trailer?.length ?? 0;

  const buffer = new ArrayBuffer(pos);
  const view = new DataView(buffer);
  view.setUint16(base, le ? 0x4949 : 0x4d4d, false);
  view.setUint16(base + 2, 42, le);
  view.setUint32(base + 4, ifdAt[0] - base, le);

  specs.forEach((s, i) => {
    const fields = s.subIfds
      ? [...s.fields, field(TIFF_TAG.SubIFDs, TYPE.LONG, ...s.subIfds.map((k) => ifdAt[k] - base))]
      : s.fields;
    let p = ifdAt[i];
    let heap = heapAt[i];
    view.setUint16(p, fields.length, le);
    p += 2;
    for (const f of fields) {
      view.setUint16(p, f.tag, le);
      view.setUint16(p + 2, f.type, le);
      view.setUint32(p + 4, countOf(f), le);
      if (byteLen(f) > 4) {
        view.setUint32(p + 8, heap - base, le);
        writeValues(view, heap, f, le);
        heap += byteLen(f);
      } else {
        writeValues(view, p + 8, f, le);
      }
      p += 12;
    }
    view.setUint32(p, s.next === undefined ? 0 : ifdAt[s.next] - base, le);
  });

  if (opts.trailer) new Uint8Array(buffer).set(opts.trailer, trailerOffset);
  return { buffer, trailerOffset };
}
