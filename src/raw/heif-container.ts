// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The boxes of a HEIF file (ISO/IEC 23008-12 over ISOBMFF) that say what its
// primary image is, read through ranged slices of the file: the size, turn,
// mirror, colour description and bit depth of the primary item, and where
// its Exif and XMP items lie. Only the top-level box headers and the meta box
// are read, never the coded image, so an Exif item at the far end of a large
// file costs one more small read. Damaged or foreign input answers null.

/** Bytes of the file, absolute. */
export interface ByteRange {
  offset: number;
  length: number;
}

export interface HeifNclx {
  primaries: number;
  transfer: number;
  matrix: number;
  fullRange: boolean;
}

export interface HeifContainer {
  primaryItem: number;
  /** The coded size (ispe) before any turn, mirror or clean-aperture crop;
   *  0 when the item carries none. */
  width: number;
  height: number;
  /** Clockwise degrees the decoder turns the image by (irot). */
  rotation: number;
  /** The axis the decoder mirrors the image about (imir), applied before the turn. */
  mirrorAxis: "vertical" | "horizontal" | null;
  nclx: HeifNclx | null;
  /** An ICC profile (colr prof or rICC). */
  icc: Uint8Array<ArrayBuffer> | null;
  /** Bits per channel (pixi), when declared. */
  bitDepth: number | null;
  /** The extents of the Exif item describing the primary image. */
  exif: ByteRange[] | null;
  /** The extents of its XMP item (mime application/rdf+xml). */
  xmp: ByteRange[] | null;
}

const BRANDS = new Set(["heic", "heix", "hevc", "hevx", "mif1", "msf1", "heim", "heis"]);
const XMP_MIME = "application/rdf+xml";

const MAX_FTYP = 4096;
const MAX_META = 16 << 20;
const MAX_ITEM = 4 << 20;
const MAX_TOP_BOXES = 64;

class Malformed extends Error {}

const fail = (): never => {
  throw new Malformed();
};

const fourcc = (view: DataView, at: number): string =>
  String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));

function uint(view: DataView, at: number, size: number): number {
  switch (size) {
    case 0: return 0;
    case 1: return view.getUint8(at);
    case 2: return view.getUint16(at);
    case 4: return view.getUint32(at);
    case 8: {
      const value = view.getBigUint64(at);
      return value > BigInt(Number.MAX_SAFE_INTEGER) ? fail() : Number(value);
    }
    default: return fail();
  }
}

/** A box: its type and payload bounds (after the header), relative to the view. */
interface Box {
  type: string;
  start: number;
  end: number;
}

/** The box whose header starts at `at` in `view`; `limit` bounds where it may end. */
function boxAt(view: DataView, at: number, limit: number): Box {
  if (at + 8 > limit) fail();
  let size = view.getUint32(at);
  const type = fourcc(view, at + 4);
  let start = at + 8;
  if (size === 1) {
    if (at + 16 > limit) fail();
    size = uint(view, at + 8, 8);
    start = at + 16;
  } else if (size === 0) {
    size = limit - at;
  }
  if (size < start - at || at + size > limit) fail();
  return { type, start, end: at + size };
}

function children(view: DataView, start: number, end: number): Box[] {
  const out: Box[] = [];
  for (let at = start; at < end; ) {
    const child = boxAt(view, at, end);
    out.push(child);
    at = child.end;
  }
  return out;
}

const child = (boxes: Box[], type: string): Box | undefined => boxes.find((b) => b.type === type);

async function readRange(file: Blob, offset: number, length: number): Promise<DataView> {
  const buffer = await file.slice(offset, offset + length).arrayBuffer();
  if (buffer.byteLength !== length) fail();
  return new DataView(buffer);
}

function brandsAreHeif(view: DataView, ftyp: Box): boolean {
  if (ftyp.type !== "ftyp" || ftyp.end - ftyp.start < 8) return false;
  if (BRANDS.has(fourcc(view, ftyp.start))) return true;
  for (let at = ftyp.start + 8; at + 4 <= ftyp.end; at += 4) {
    if (BRANDS.has(fourcc(view, at))) return true;
  }
  return false;
}

/** Whether `head` (the file's first bytes, the whole ftyp box among them)
 *  opens a HEIF file. */
export function isHeifHead(head: Uint8Array): boolean {
  try {
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    return brandsAreHeif(view, boxAt(view, 0, head.byteLength));
  } catch {
    return false;
  }
}

/** The meta box: its bytes and where they sit in the file. */
async function findMeta(file: Blob): Promise<{ view: DataView; at: number; box: Box } | null> {
  const ftypHead = await readRange(file, 0, Math.min(file.size, MAX_FTYP));
  const ftyp = boxAt(ftypHead, 0, ftypHead.byteLength);
  if (!brandsAreHeif(ftypHead, ftyp)) return null;
  let at = ftyp.end;
  for (let n = 0; n < MAX_TOP_BOXES && at + 8 <= file.size; n++) {
    const head = await readRange(file, at, Math.min(16, file.size - at));
    const header = boxAt(head, 0, file.size - at);
    const size = header.end;
    if (header.type === "meta") {
      if (size > MAX_META) return null;
      const view = await readRange(file, at, size);
      return { view, at, box: boxAt(view, 0, size) };
    }
    at += size;
  }
  return null;
}

interface Item {
  type: string;
  mime: string;
  extents: ByteRange[] | null;
}

function readInfe(view: DataView, infe: Box, items: Map<number, Item>): void {
  const version = view.getUint8(infe.start);
  if (version < 2) return;
  let at = infe.start + 4;
  const id = version === 2 ? view.getUint16(at) : view.getUint32(at);
  at += version === 2 ? 4 : 6;
  const type = fourcc(view, at);
  at += 4;
  const cString = (): string => {
    let s = "";
    while (at < infe.end) {
      const c = view.getUint8(at++);
      if (c === 0) return s;
      s += String.fromCharCode(c);
    }
    return s;
  };
  cString();
  const mime = type === "mime" ? cString() : "";
  items.set(id, { type, mime, extents: null });
}

function readIloc(view: DataView, iloc: Box, idat: Box | undefined, metaAt: number, fileSize: number,
  items: Map<number, Item>): void {
  const version = view.getUint8(iloc.start);
  if (version > 2) fail();
  let at = iloc.start + 4;
  const sizes = view.getUint16(at);
  at += 2;
  const offsetSize = sizes >> 12;
  const lengthSize = (sizes >> 8) & 0xf;
  const baseSize = (sizes >> 4) & 0xf;
  const indexSize = version > 0 ? sizes & 0xf : 0;
  const read = (size: number): number => {
    if (at + size > iloc.end) fail();
    const value = uint(view, at, size);
    at += size;
    return value;
  };
  const count = read(version < 2 ? 2 : 4);
  for (let i = 0; i < count; i++) {
    const id = read(version < 2 ? 2 : 4);
    const method = version > 0 ? read(2) & 0xf : 0;
    const dataReference = read(2);
    const base = read(baseSize);
    const extentCount = read(2);
    const extents: ByteRange[] = [];
    for (let e = 0; e < extentCount; e++) {
      read(indexSize);
      const offset = base + read(offsetSize);
      const length = read(lengthSize);
      extents.push({ offset, length });
    }
    const item = items.get(id);
    if (!item || dataReference !== 0) continue;
    if (method === 0) {
      item.extents = extents.map(({ offset, length }) => ({ offset, length: length || fileSize - offset }));
    } else if (method === 1 && idat) {
      const idatAt = metaAt + idat.start;
      const idatLength = idat.end - idat.start;
      item.extents = extents.map(({ offset, length }) => ({
        offset: idatAt + offset,
        length: length || idatLength - offset,
      }));
      if (extents.some(({ offset, length }) => offset + length > idatLength)) item.extents = null;
    }
  }
}

/** `from` → `to` item references of one type. */
function readIref(view: DataView, iref: Box): { type: string; from: number; to: number[] }[] {
  const wide = view.getUint8(iref.start) > 0;
  const size = wide ? 4 : 2;
  return children(view, iref.start + 4, iref.end).map((ref) => {
    let at = ref.start;
    const from = uint(view, at, size);
    at += size;
    const count = view.getUint16(at);
    at += 2;
    if (at + count * size > ref.end) fail();
    const to = Array.from({ length: count }, (_, i) => uint(view, at + i * size, size));
    return { type: ref.type, from, to };
  });
}

/** Each item's property indices (1-based into ipco). */
function readIpma(view: DataView, ipma: Box, into: Map<number, number[]>): void {
  const version = view.getUint8(ipma.start);
  const wideIndex = (view.getUint32(ipma.start) & 1) === 1;
  let at = ipma.start + 4;
  const count = view.getUint32(at);
  at += 4;
  for (let i = 0; i < count; i++) {
    const id = version < 1 ? view.getUint16(at) : view.getUint32(at);
    at += version < 1 ? 2 : 4;
    const n = view.getUint8(at++);
    const indices = into.get(id) ?? [];
    for (let k = 0; k < n; k++) {
      indices.push(wideIndex ? view.getUint16(at) & 0x7fff : view.getUint8(at) & 0x7f);
      at += wideIndex ? 2 : 1;
    }
    if (at > ipma.end) fail();
    into.set(id, indices);
  }
}

interface Properties {
  width: number;
  height: number;
  rotation: number;
  mirrorAxis: HeifContainer["mirrorAxis"];
  nclx: HeifNclx | null;
  icc: Uint8Array<ArrayBuffer> | null;
  bitDepth: number | null;
}

function readProperties(view: DataView, boxes: Box[]): Properties {
  const out: Properties = {
    width: 0, height: 0, rotation: 0, mirrorAxis: null, nclx: null, icc: null, bitDepth: null,
  };
  for (const b of boxes) {
    const length = b.end - b.start;
    if (b.type === "ispe" && length >= 12) {
      out.width = view.getUint32(b.start + 4);
      out.height = view.getUint32(b.start + 8);
    } else if (b.type === "irot" && length >= 1) {
      out.rotation = ((4 - (view.getUint8(b.start) & 3)) % 4) * 90;
    } else if (b.type === "imir" && length >= 1) {
      out.mirrorAxis = (view.getUint8(b.start) & 1) === 0 ? "vertical" : "horizontal";
    } else if (b.type === "pixi" && length >= 6) {
      out.bitDepth = view.getUint8(b.start + 5);
    } else if (b.type === "colr" && length >= 4) {
      const kind = fourcc(view, b.start);
      if (kind === "nclx" && length >= 11 && !out.nclx) {
        out.nclx = {
          primaries: view.getUint16(b.start + 4),
          transfer: view.getUint16(b.start + 6),
          matrix: view.getUint16(b.start + 8),
          fullRange: (view.getUint8(b.start + 10) & 0x80) !== 0,
        };
      } else if ((kind === "prof" || kind === "rICC") && length > 4 && !out.icc) {
        out.icc = new Uint8Array(view.buffer, view.byteOffset + b.start + 4, length - 4).slice();
      }
    }
  }
  return out;
}

/** The boxes of the primary image of a HEIF file, or null when `file` isn't
 *  one this reader can follow. Never rejects. */
export async function readHeifContainer(file: Blob): Promise<HeifContainer | null> {
  try {
    const meta = await findMeta(file);
    if (!meta) return null;
    const { view, at: metaAt } = meta;
    const boxes = children(view, meta.box.start + 4, meta.box.end);
    const hdlr = child(boxes, "hdlr");
    if (!hdlr || hdlr.end - hdlr.start < 12 || fourcc(view, hdlr.start + 8) !== "pict") return null;
    const pitm = child(boxes, "pitm");
    const iinf = child(boxes, "iinf");
    const iloc = child(boxes, "iloc");
    const iprp = child(boxes, "iprp");
    if (!pitm || !iinf || !iloc || !iprp) return null;

    const primaryItem = view.getUint8(pitm.start) === 0 ? view.getUint16(pitm.start + 4) : view.getUint32(pitm.start + 4);
    const items = new Map<number, Item>();
    const infeStart = iinf.start + (view.getUint8(iinf.start) === 0 ? 6 : 8);
    for (const infe of children(view, infeStart, iinf.end)) {
      if (infe.type === "infe") readInfe(view, infe, items);
    }
    if (!items.has(primaryItem)) return null;
    readIloc(view, iloc, child(boxes, "idat"), metaAt, file.size, items);
    const iref = child(boxes, "iref");
    const refs = iref ? readIref(view, iref) : [];

    const iprpBoxes = children(view, iprp.start, iprp.end);
    const ipco = child(iprpBoxes, "ipco");
    if (!ipco) return null;
    const properties = children(view, ipco.start, ipco.end);
    const associations = new Map<number, number[]>();
    for (const ipma of iprpBoxes) if (ipma.type === "ipma") readIpma(view, ipma, associations);
    const propertiesOf = (id: number): Box[] =>
      (associations.get(id) ?? []).flatMap((index) => (index > 0 && properties[index - 1] ? [properties[index - 1]] : []));

    const primary = readProperties(view, propertiesOf(primaryItem));
    // A grid's colour and depth may sit on its tiles alone.
    const tile = refs.find((r) => r.type === "dimg" && r.from === primaryItem)?.to[0];
    if (tile !== undefined && ((!primary.nclx && !primary.icc) || primary.bitDepth === null)) {
      const tileProps = readProperties(view, propertiesOf(tile));
      if (!primary.nclx && !primary.icc) {
        primary.nclx = tileProps.nclx;
        primary.icc = tileProps.icc;
      }
      primary.bitDepth ??= tileProps.bitDepth;
    }

    const describing = (match: (item: Item) => boolean): ByteRange[] | null => {
      let fallback: ByteRange[] | null = null;
      for (const [id, item] of items) {
        if (!match(item) || !item.extents) continue;
        if (refs.some((r) => r.type === "cdsc" && r.from === id && r.to.includes(primaryItem))) return item.extents;
        fallback ??= item.extents;
      }
      return fallback;
    };

    return {
      primaryItem,
      ...primary,
      exif: describing((item) => item.type === "Exif"),
      xmp: describing((item) => item.type === "mime" && item.mime === XMP_MIME),
    };
  } catch {
    return null;
  }
}

async function readItem(file: Blob, extents: ByteRange[]): Promise<Uint8Array<ArrayBuffer> | null> {
  const total = extents.reduce((sum, e) => sum + e.length, 0);
  if (total > MAX_ITEM || extents.some((e) => e.offset + e.length > file.size)) return null;
  const out = new Uint8Array(total);
  let at = 0;
  for (const { offset, length } of extents) {
    out.set(new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()), at);
    at += length;
  }
  return out;
}

const isTiffAt = (b: Uint8Array, at: number): boolean =>
  at + 4 <= b.length &&
  ((b[at] === 0x49 && b[at + 1] === 0x49 && b[at + 2] === 0x2a && b[at + 3] === 0) ||
    (b[at] === 0x4d && b[at + 1] === 0x4d && b[at + 2] === 0 && b[at + 3] === 0x2a));

/** The TIFF structure of the primary image's Exif item: past the item's
 *  4-byte header offset and the bytes it skips. Null when there is none or
 *  it can't be read. Never rejects. */
export async function readHeifExif(file: Blob, container?: HeifContainer | null): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    const info = container === undefined ? await readHeifContainer(file) : container;
    if (!info?.exif) return null;
    const item = await readItem(file, info.exif);
    if (!item || item.length < 8) return null;
    const declared = 4 + new DataView(item.buffer).getUint32(0);
    // Some writers count the "Exif\0\0" prefix and some don't; the TIFF magic decides.
    let start = isTiffAt(item, declared) ? declared : -1;
    for (let at = 4; start < 0 && at < Math.min(item.length, 64); at++) if (isTiffAt(item, at)) start = at;
    return start < 0 ? null : item.slice(start);
  } catch {
    return null;
  }
}

/** The primary image's XMP packet, as stored. Never rejects. */
export async function readHeifXmp(file: Blob, container?: HeifContainer | null): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    const info = container === undefined ? await readHeifContainer(file) : container;
    return info?.xmp ? await readItem(file, info.xmp) : null;
  } catch {
    return null;
  }
}
