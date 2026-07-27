// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, it, expect } from "vitest";
import {
  COMPRESSION,
  PHOTOMETRIC_CFA,
  TIFF_TAG,
  TiffReader,
  findRawIfd,
  type Ifd,
  type TiffEntry,
} from "./tiff";

const TYPE = {
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

interface Field {
  tag: number;
  type: number;
  /** RATIONAL/SRATIONAL hold flattened numerator/denominator pairs. */
  values: number[];
}

interface IfdSpec {
  fields: Field[];
  /** Spec indices to link through a SubIFDs (0x014a) field. */
  subIfds?: number[];
  /** Spec index to link through the next-IFD pointer. */
  next?: number;
}

const field = (tag: number, type: number, ...values: number[]): Field => ({ tag, type, values });

const asciiField = (tag: number, text: string): Field => ({
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
 * header is embedded (e.g. inside a JPEG APP1 segment).
 */
function buildTiff(specs: IfdSpec[], opts: { littleEndian?: boolean; base?: number } = {}): ArrayBuffer {
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

  return buffer;
}

const widthOf = (reader: TiffReader, ifd: Ifd): number | undefined =>
  reader.first(ifd.get(TIFF_TAG.ImageWidth));

function entry(ifd: Ifd, tag: number): TiffEntry {
  const e = ifd.get(tag);
  if (!e) throw new Error(`no entry for tag 0x${tag.toString(16)}`);
  return e;
}

describe("TiffReader header", () => {
  it("reads a little-endian file", () => {
    const reader = new TiffReader(
      buildTiff([
        {
          fields: [
            field(TIFF_TAG.ImageWidth, TYPE.SHORT, 4000),
            field(TIFF_TAG.ImageLength, TYPE.SHORT, 3000),
            asciiField(TIFF_TAG.Make, "NIKON CORPORATION"),
          ],
        },
      ]),
    );

    expect(reader.le).toBe(true);
    expect(reader.ifds).toHaveLength(1);
    expect(widthOf(reader, reader.ifds[0])).toBe(4000);
    expect(reader.first(reader.ifds[0].get(TIFF_TAG.ImageLength))).toBe(3000);
    expect(reader.ascii(reader.ifds[0].get(TIFF_TAG.Make))).toBe("NIKON CORPORATION");
  });

  it("reads a big-endian file the same way", () => {
    const spec: IfdSpec[] = [
      {
        fields: [
          field(TIFF_TAG.ImageWidth, TYPE.LONG, 6048),
          asciiField(TIFF_TAG.Model, "ILCE-7M3"),
        ],
      },
    ];
    const reader = new TiffReader(buildTiff(spec, { littleEndian: false }));

    expect(reader.le).toBe(false);
    expect(widthOf(reader, reader.ifds[0])).toBe(6048);
    expect(reader.ascii(reader.ifds[0].get(TIFF_TAG.Model))).toBe("ILCE-7M3");
  });

  it("resolves offsets relative to a non-zero header base", () => {
    const reader = new TiffReader(
      buildTiff([{ fields: [asciiField(TIFF_TAG.Make, "Canon Inc.")] }], { base: 12 }),
      12,
    );

    expect(reader.base).toBe(12);
    expect(reader.ascii(reader.ifds[0].get(TIFF_TAG.Make))).toBe("Canon Inc.");
  });

  it("rejects streams that are not TIFF", () => {
    const notTiff = new ArrayBuffer(16);
    expect(() => new TiffReader(notTiff)).toThrow("Not a TIFF stream");

    const badMagic = buildTiff([{ fields: [field(TIFF_TAG.ImageWidth, TYPE.SHORT, 1)] }]);
    new DataView(badMagic).setUint16(2, 43, true);
    expect(() => new TiffReader(badMagic)).toThrow("Bad TIFF magic");
  });
});

describe("TiffReader IFD traversal", () => {
  it("follows the next-IFD chain", () => {
    const reader = new TiffReader(
      buildTiff([
        { fields: [field(TIFF_TAG.ImageWidth, TYPE.SHORT, 160)], next: 1 },
        { fields: [field(TIFF_TAG.ImageWidth, TYPE.SHORT, 320)] },
      ]),
    );

    expect(reader.ifds.map((ifd) => widthOf(reader, ifd))).toEqual([160, 320]);
  });

  it("recurses into SubIFDs before continuing the chain", () => {
    const reader = new TiffReader(
      buildTiff([
        { fields: [field(TIFF_TAG.ImageWidth, TYPE.SHORT, 1)], subIfds: [2, 3], next: 1 },
        { fields: [field(TIFF_TAG.ImageWidth, TYPE.SHORT, 2)] },
        { fields: [field(TIFF_TAG.ImageWidth, TYPE.SHORT, 3)] },
        { fields: [field(TIFF_TAG.ImageWidth, TYPE.SHORT, 4)] },
      ]),
    );

    expect(reader.ifds.map((ifd) => widthOf(reader, ifd))).toEqual([1, 3, 4, 2]);
  });

  it("stops at an IFD chain that points back at itself", () => {
    const reader = new TiffReader(
      buildTiff([{ fields: [field(TIFF_TAG.ImageWidth, TYPE.SHORT, 8)], next: 0 }]),
    );

    expect(reader.ifds).toHaveLength(1);
  });

  it("caps SubIFD nesting at eight levels", () => {
    const depth = 12;
    const specs: IfdSpec[] = Array.from({ length: depth }, (_, i) => ({
      fields: [field(TIFF_TAG.ImageWidth, TYPE.SHORT, i)],
      subIfds: i + 1 < depth ? [i + 1] : undefined,
    }));
    const reader = new TiffReader(buildTiff(specs));

    expect(reader.ifds.map((ifd) => widthOf(reader, ifd))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

describe("TiffReader values", () => {
  it("decodes every numeric field type", () => {
    const reader = new TiffReader(
      buildTiff([
        {
          fields: [
            field(0x1001, TYPE.BYTE, 1, 2, 3, 4),
            field(0x1002, TYPE.SBYTE, -1, 127),
            field(0x1003, TYPE.SHORT, 65535),
            field(0x1004, TYPE.SSHORT, -32768),
            field(0x1005, TYPE.LONG, 4294967295),
            field(0x1006, TYPE.SLONG, -2147483648),
            field(0x1007, TYPE.RATIONAL, 3, 4),
            field(0x1008, TYPE.SRATIONAL, -1, 8),
            field(0x1009, TYPE.FLOAT, 1.5, -0.25),
            field(0x100a, TYPE.DOUBLE, 2.25),
            field(0x100b, TYPE.UNDEFINED, 0xde, 0xad),
          ],
        },
      ]),
    );
    const ifd = reader.ifds[0];
    const read = (tag: number): number[] => reader.values(entry(ifd, tag));

    expect(read(0x1001)).toEqual([1, 2, 3, 4]);
    expect(read(0x1002)).toEqual([-1, 127]);
    expect(read(0x1003)).toEqual([65535]);
    expect(read(0x1004)).toEqual([-32768]);
    expect(read(0x1005)).toEqual([4294967295]);
    expect(read(0x1006)).toEqual([-2147483648]);
    expect(read(0x1007)).toEqual([0.75]);
    expect(read(0x1008)).toEqual([-0.125]);
    expect(read(0x1009)).toEqual([1.5, -0.25]);
    expect(read(0x100a)).toEqual([2.25]);
    expect(read(0x100b)).toEqual([0xde, 0xad]);
  });

  it("treats a zero denominator as zero rather than infinity", () => {
    const reader = new TiffReader(
      buildTiff([{ fields: [field(0x1007, TYPE.RATIONAL, 1, 0), field(0x1008, TYPE.SRATIONAL, -1, 0)] }]),
    );

    expect(reader.first(reader.ifds[0].get(0x1007))).toBe(0);
    expect(reader.first(reader.ifds[0].get(0x1008))).toBe(0);
  });

  it("reads values inline when they fit in four bytes and out of line when they do not", () => {
    const reader = new TiffReader(
      buildTiff([
        {
          fields: [
            field(0x2001, TYPE.SHORT, 111, 222), // 4 bytes: inline
            field(0x2002, TYPE.SHORT, 1, 2, 3, 4), // 8 bytes: heap pointer
          ],
        },
      ]),
    );
    const ifd = reader.ifds[0];

    expect(reader.values(entry(ifd, 0x2001))).toEqual([111, 222]);
    expect(reader.values(entry(ifd, 0x2002))).toEqual([1, 2, 3, 4]);
  });

  it("stops reading values that run past the end of the buffer", () => {
    const full = buildTiff([{ fields: [field(0x2002, TYPE.LONG, 10, 20, 30, 40)] }]);
    // Keep the header and IFD, cut the 16-byte heap down to one LONG.
    const reader = new TiffReader(full.slice(0, 8 + 2 + 12 + 4 + 4));

    expect(reader.values(entry(reader.ifds[0], 0x2002))).toEqual([10]);
  });

  it("survives a file truncated mid-IFD", () => {
    const full = buildTiff([
      { fields: [field(TIFF_TAG.ImageWidth, TYPE.SHORT, 100), field(TIFF_TAG.ImageLength, TYPE.SHORT, 50)] },
    ]);
    const reader = new TiffReader(full.slice(0, 16));

    expect(reader.ifds[0].size).toBe(0);
  });

  it("returns undefined from first() for a missing entry", () => {
    const reader = new TiffReader(buildTiff([{ fields: [field(TIFF_TAG.ImageWidth, TYPE.SHORT, 9)] }]));

    expect(reader.first(reader.ifds[0].get(TIFF_TAG.Model))).toBeUndefined();
    expect(reader.first(reader.ifds[0].get(TIFF_TAG.ImageWidth))).toBe(9);
  });
});

describe("TiffReader ascii", () => {
  it("stops at the NUL terminator and trims padding", () => {
    const reader = new TiffReader(
      buildTiff([
        {
          fields: [
            asciiField(TIFF_TAG.Make, "  SONY  "),
            { tag: TIFF_TAG.Model, type: TYPE.ASCII, values: [0x41, 0x42, 0x00, 0x5a] },
          ],
        },
      ]),
    );

    expect(reader.ascii(reader.ifds[0].get(TIFF_TAG.Make))).toBe("SONY");
    // Trailing 'Z' sits past the NUL and must not appear.
    expect(reader.ascii(reader.ifds[0].get(TIFF_TAG.Model))).toBe("AB");
  });

  it("stops at the end of a truncated value heap", () => {
    const full = buildTiff([{ fields: [asciiField(TIFF_TAG.Make, "NIKON CORPORATION")] }]);
    const heapAt = 8 + 2 + 12 + 4;
    // Keep the header and IFD; cut the 18-byte string down to its first five characters.
    const partial = new TiffReader(full.slice(0, heapAt + 5));
    const gone = new TiffReader(full.slice(0, heapAt));

    expect(partial.ascii(partial.ifds[0].get(TIFF_TAG.Make))).toBe("NIKON");
    expect(gone.ascii(gone.ifds[0].get(TIFF_TAG.Make))).toBeUndefined();
  });

  it("returns undefined for absent, empty, and non-ASCII-typed entries", () => {
    const reader = new TiffReader(
      buildTiff([
        {
          fields: [
            asciiField(TIFF_TAG.Make, ""),
            field(TIFF_TAG.Model, TYPE.SHORT, 1234),
          ],
        },
      ]),
    );

    expect(reader.ascii(undefined)).toBeUndefined();
    expect(reader.ascii(reader.ifds[0].get(TIFF_TAG.Make))).toBeUndefined();
    expect(reader.ascii(reader.ifds[0].get(TIFF_TAG.Model))).toBeUndefined();
  });
});

describe("findRawIfd", () => {
  const cfaIfd = (width: number, height: number, extra: Field[] = []): IfdSpec => ({
    fields: [
      field(TIFF_TAG.PhotometricInterpretation, TYPE.SHORT, PHOTOMETRIC_CFA),
      field(TIFF_TAG.ImageWidth, TYPE.LONG, width),
      field(TIFF_TAG.ImageLength, TYPE.LONG, height),
      ...extra,
    ],
  });

  it("returns null when no IFD is a colour filter array", () => {
    const reader = new TiffReader(
      buildTiff([
        {
          fields: [
            field(TIFF_TAG.PhotometricInterpretation, TYPE.SHORT, 2),
            field(TIFF_TAG.ImageWidth, TYPE.LONG, 6000),
            field(TIFF_TAG.ImageLength, TYPE.LONG, 4000),
          ],
        },
      ]),
    );

    expect(findRawIfd(reader)).toBeNull();
  });

  it("picks the largest-area CFA IFD, ignoring RGB and degenerate ones", () => {
    const reader = new TiffReader(
      buildTiff([
        { fields: [field(TIFF_TAG.PhotometricInterpretation, TYPE.SHORT, 2)], subIfds: [1, 2, 3] },
        cfaIfd(640, 480),
        cfaIfd(6048, 4024),
        cfaIfd(1, 1),
      ]),
    );

    const raw = findRawIfd(reader);
    expect(raw).not.toBeNull();
    expect([raw?.width, raw?.height]).toEqual([6048, 4024]);
  });

  it("reports compression and bit depth from the chosen IFD", () => {
    const reader = new TiffReader(
      buildTiff([
        cfaIfd(6048, 4024, [
          field(TIFF_TAG.Compression, TYPE.SHORT, COMPRESSION.NikonNEF),
          field(TIFF_TAG.BitsPerSample, TYPE.SHORT, 14),
        ]),
      ]),
    );

    expect(findRawIfd(reader)?.compression).toBe(COMPRESSION.NikonNEF);
    expect(findRawIfd(reader)?.bitsPerSample).toBe(14);
  });

  it("defaults to uncompressed 16-bit when the tags are absent", () => {
    const reader = new TiffReader(buildTiff([cfaIfd(16, 16)]));
    const raw = findRawIfd(reader);

    expect(raw?.compression).toBe(COMPRESSION.None);
    expect(raw?.bitsPerSample).toBe(16);
    expect(raw?.ifd).toBe(reader.ifds[0]);
  });
});
