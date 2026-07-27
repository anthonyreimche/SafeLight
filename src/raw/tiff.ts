// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Minimal full-file TIFF reader for RAW containers (NEF, DNG, CR2, ARW are all
// TIFF-based). Unlike the EXIF reader in src/catalog/exif.ts — which only scans
// the first ~1 MiB for display tags — this walks the whole file and follows
// SubIFDs, because the raw sensor strip lives deep in the container.
//
// Self-contained (no imports) so it can be unit-tested directly under Node's
// --experimental-strip-types runner.

export const TIFF_TAG = {
  ImageWidth: 0x0100,
  ImageLength: 0x0101,
  BitsPerSample: 0x0102,
  Compression: 0x0103,
  PhotometricInterpretation: 0x0106,
  Make: 0x010f,
  Model: 0x0110,
  StripOffsets: 0x0111,
  SamplesPerPixel: 0x0115,
  RowsPerStrip: 0x0116,
  StripByteCounts: 0x0117,
  SubIFDs: 0x014a,
  CFARepeatPatternDim: 0x828d,
  CFAPattern: 0x828e,
  CFAPlaneColor: 0xc616,
  BlackLevel: 0xc61a,
  WhiteLevel: 0xc61d,
  AsShotNeutral: 0xc628,
} as const;

// PhotometricInterpretation value that flags a Color Filter Array (raw Bayer).
export const PHOTOMETRIC_CFA = 32803;

export const COMPRESSION = {
  None: 1,
  // Nikon's lossless-Huffman packed sensor data.
  NikonNEF: 34713,
} as const;

// TIFF field type -> byte size.
const TYPE_SIZE: Record<number, number> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  6: 1, // SBYTE
  7: 1, // UNDEFINED
  8: 2, // SSHORT
  9: 4, // SLONG
  10: 8, // SRATIONAL
  11: 4, // FLOAT
  12: 8, // DOUBLE
};

export interface TiffEntry {
  tag: number;
  type: number;
  count: number;
  valueOffset: number; // absolute offset of the entry's 4-byte value/pointer field
}

export type Ifd = Map<number, TiffEntry>;

export class TiffReader {
  readonly view: DataView;
  readonly le: boolean; // little-endian
  readonly base: number; // byte offset of the TIFF header (0 for raw TIFF)
  readonly ifds: Ifd[] = [];

  constructor(buffer: ArrayBuffer, base = 0) {
    this.view = new DataView(buffer);
    this.base = base;
    const order = this.view.getUint16(base, false);
    if (order !== 0x4949 && order !== 0x4d4d) {
      throw new Error("Not a TIFF stream");
    }
    this.le = order === 0x4949;
    if (this.u16(base + 2) !== 42) throw new Error("Bad TIFF magic");
    this.collect(this.u32(base + 4), new Set(), 0);
  }

  private u16(off: number): number {
    return this.view.getUint16(off, this.le);
  }
  private u32(off: number): number {
    return this.view.getUint32(off, this.le);
  }

  // Walk an IFD chain, recursing into SubIFDs. Guards against cycles and
  // pathological nesting so a malformed file can't hang the reader.
  private collect(offset: number, seen: Set<number>, depth: number): void {
    let at = offset;
    while (at > 0 && !seen.has(at) && depth < 8) {
      seen.add(at);
      const abs = this.base + at;
      if (abs < 0 || abs + 2 > this.view.byteLength) return;

      const count = this.u16(abs);
      const ifd: Ifd = new Map();
      let p = abs + 2;
      for (let i = 0; i < count; i++) {
        if (p + 12 > this.view.byteLength) break;
        const tag = this.u16(p);
        ifd.set(tag, {
          tag,
          type: this.u16(p + 2),
          count: this.u32(p + 4),
          valueOffset: p + 8,
        });
        p += 12;
      }
      this.ifds.push(ifd);

      const sub = ifd.get(TIFF_TAG.SubIFDs);
      if (sub) {
        for (const off of this.values(sub)) {
          this.collect(off, seen, depth + 1);
        }
      }

      // next IFD pointer follows the entries
      at = p + 4 <= this.view.byteLength ? this.u32(p) : 0;
    }
  }

  // Absolute offset of an entry's data: inline when it fits in 4 bytes,
  // otherwise a TIFF-relative pointer.
  private dataOffset(e: TiffEntry): number {
    const size = (TYPE_SIZE[e.type] ?? 1) * e.count;
    return size <= 4 ? e.valueOffset : this.base + this.u32(e.valueOffset);
  }

  // Read all numeric values of an entry (RATIONAL collapses to a ratio).
  values(e: TiffEntry): number[] {
    const sz = TYPE_SIZE[e.type] ?? 1;
    const start = this.dataOffset(e);
    const out: number[] = [];
    const v = this.view;
    for (let i = 0; i < e.count; i++) {
      const p = start + i * sz;
      if (p + sz > v.byteLength) break;
      switch (e.type) {
        case 1:
        case 7:
          out.push(v.getUint8(p));
          break;
        case 6:
          out.push(v.getInt8(p));
          break;
        case 3:
          out.push(this.u16(p));
          break;
        case 8:
          out.push(v.getInt16(p, this.le));
          break;
        case 4:
          out.push(this.u32(p));
          break;
        case 9:
          out.push(v.getInt32(p, this.le));
          break;
        case 5: {
          const n = this.u32(p);
          const d = this.u32(p + 4);
          out.push(d === 0 ? 0 : n / d);
          break;
        }
        case 10: {
          const n = v.getInt32(p, this.le);
          const d = v.getInt32(p + 4, this.le);
          out.push(d === 0 ? 0 : n / d);
          break;
        }
        case 11:
          out.push(v.getFloat32(p, this.le));
          break;
        case 12:
          out.push(v.getFloat64(p, this.le));
          break;
        default:
          out.push(v.getUint8(p));
      }
    }
    return out;
  }

  first(e: TiffEntry | undefined): number | undefined {
    if (!e) return undefined;
    return this.values(e)[0];
  }

  ascii(e: TiffEntry | undefined): string | undefined {
    if (!e || e.type !== 2) return undefined;
    const start = this.dataOffset(e);
    let s = "";
    for (let i = 0; i < e.count; i++) {
      const p = start + i;
      if (p + 1 > this.view.byteLength) break;
      const c = this.view.getUint8(p);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s.trim() || undefined;
  }
}

export interface RawIfdInfo {
  ifd: Ifd;
  width: number;
  height: number;
  compression: number;
  bitsPerSample: number;
}

// Pick the IFD that holds the full-resolution sensor data: a CFA photometric
// interpretation with the largest pixel area.
export function findRawIfd(reader: TiffReader): RawIfdInfo | null {
  let best: RawIfdInfo | null = null;
  for (const ifd of reader.ifds) {
    const photo = reader.first(ifd.get(TIFF_TAG.PhotometricInterpretation));
    if (photo !== PHOTOMETRIC_CFA) continue;
    const width = reader.first(ifd.get(TIFF_TAG.ImageWidth)) ?? 0;
    const height = reader.first(ifd.get(TIFF_TAG.ImageLength)) ?? 0;
    // Skip degenerate entries; the largest-area CFA IFD wins below.
    if (width < 2 || height < 2) continue;
    const candidate: RawIfdInfo = {
      ifd,
      width,
      height,
      compression: reader.first(ifd.get(TIFF_TAG.Compression)) ?? 1,
      bitsPerSample: reader.first(ifd.get(TIFF_TAG.BitsPerSample)) ?? 16,
    };
    if (!best || width * height > best.width * best.height) best = candidate;
  }
  return best;
}
