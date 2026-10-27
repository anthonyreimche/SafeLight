// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Reads one IFD of a TIFF-structured file, which is what a DNG camera profile
// (DCP), a DNG and most RAW formats are underneath. Enough for the camera
// profile build tool: numeric values come back as numbers (rationals divided
// out), ASCII as a string. `skipTruncated` is for reading a RAW's IFD0 from only
// its first megabyte: a tag whose value lies past that cut is left out, rather
// than read from a clipped buffer, so a short name never comes back as a wrong one.

export type TagValue = number[] | string;

const TYPE_SIZE: Readonly<Record<number, number>> = {
  1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8,
};

/** Byte order and the first IFD's offset, when the file starts with "II" or
 *  "MM" and then `magic` (42 for TIFF and DNG, 0x4352 for a DCP). */
export function readHeader(bytes: Uint8Array, magic: number): { littleEndian: boolean; ifd: number } | null {
  if (bytes.length < 8) return null;
  const order = String.fromCharCode(bytes[0], bytes[1]);
  if (order !== "II" && order !== "MM") return null;
  const littleEndian = order === "II";
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(2, littleEndian) !== magic) return null;
  return { littleEndian, ifd: view.getUint32(4, littleEndian) };
}

/** The tags of the IFD at `offset`. Entries of a type it doesn't know are skipped.
 *  A tag whose value runs past the end of `bytes` throws, naming the tag, unless
 *  `skipTruncated` leaves it out. An IFD whose entry table runs past the end
 *  always throws. */
export function readIfd(
  bytes: Uint8Array,
  offset: number,
  littleEndian: boolean,
  { skipTruncated = false }: { skipTruncated?: boolean } = {},
): Map<number, TagValue> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (offset + 2 > bytes.length) throw new Error(`IFD at ${offset} runs past the end of the file`);
  const count = view.getUint16(offset, littleEndian);
  if (offset + 2 + count * 12 > bytes.length) throw new Error(`IFD at ${offset} runs past the end of the file`);
  const tags = new Map<number, TagValue>();
  for (let i = 0; i < count; i++) {
    const entry = offset + 2 + i * 12;
    const tag = view.getUint16(entry, littleEndian);
    const type = view.getUint16(entry + 2, littleEndian);
    const n = view.getUint32(entry + 4, littleEndian);
    const size = TYPE_SIZE[type];
    if (!size) continue;
    const at = size * n <= 4 ? entry + 8 : view.getUint32(entry + 8, littleEndian);
    if (at + size * n > bytes.length) {
      if (skipTruncated) continue;
      throw new Error(`tag 0x${tag.toString(16).padStart(4, "0")} runs past the end of the file`);
    }
    tags.set(tag, readValue(bytes, view, at, type, n, littleEndian));
  }
  return tags;
}

function readValue(
  bytes: Uint8Array,
  view: DataView,
  at: number,
  type: number,
  n: number,
  le: boolean,
): TagValue {
  if (type === 2) return new TextDecoder().decode(bytes.subarray(at, at + n)).replace(/\0+$/, "");
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    switch (type) {
      case 1:
      case 7:
        out.push(view.getUint8(at + i));
        break;
      case 6:
        out.push(view.getInt8(at + i));
        break;
      case 3:
        out.push(view.getUint16(at + i * 2, le));
        break;
      case 8:
        out.push(view.getInt16(at + i * 2, le));
        break;
      case 4:
        out.push(view.getUint32(at + i * 4, le));
        break;
      case 9:
        out.push(view.getInt32(at + i * 4, le));
        break;
      case 5:
        out.push(view.getUint32(at + i * 8, le) / (view.getUint32(at + i * 8 + 4, le) || 1));
        break;
      case 10:
        out.push(view.getInt32(at + i * 8, le) / (view.getInt32(at + i * 8 + 4, le) || 1));
        break;
      case 11:
        out.push(view.getFloat32(at + i * 4, le));
        break;
      case 12:
        out.push(view.getFloat64(at + i * 8, le));
        break;
    }
  }
  return out;
}
