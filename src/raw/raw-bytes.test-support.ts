// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Test-only bytes of a RAW file: zero filler with camera previews embedded at
// chosen offsets, as the byte scan in raw-preview.ts finds them. Not imported
// by production code.

/** A baseline JPEG the scan accepts: SOF0 naming its frame size, then `payload`
 *  bytes of scan data (never 0xFF, so nothing reads as a marker), then EOI. */
export function jpegBytes(width: number, height: number, payload = 16): Uint8Array {
  const head = [
    0xff, 0xd8, // SOI
    0xff, 0xc0, 0x00, 0x0b, 0x08, // SOF0, length 11, precision 8
    height >> 8, height & 0xff, width >> 8, width & 0xff,
    0x01, 0x01, 0x11, 0x00, // one component
    0xff, 0xda, 0x00, 0x02, // SOS
  ];
  const out = new Uint8Array(head.length + payload + 2);
  out.set(head);
  out.fill(0x11, head.length, head.length + payload);
  out.set([0xff, 0xd9], head.length + payload); // EOI
  return out;
}

export interface EmbeddedPreview {
  /** Byte offset of the preview's SOI in the file. */
  at: number;
  width: number;
  height: number;
  /** Bytes of scan data, which sets how large the preview is on disk. */
  payload: number;
}

/** `size` bytes of RAW holding each preview at its offset. */
export function rawBytes(size: number, previews: EmbeddedPreview[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(size);
  for (const p of previews) out.set(jpegBytes(p.width, p.height, p.payload), p.at);
  return out;
}

export const MiB = 1 << 20;
