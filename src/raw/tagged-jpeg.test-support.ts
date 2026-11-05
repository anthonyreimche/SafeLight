// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Real JPEGs for the browser-run decode tests: Chromium encodes a frame whose
// left half is red and right half blue, then an Exif APP1 carrying the given
// Orientation is spliced in behind the SOI — the shape of a camera JPEG, and of
// the full-EXIF preview a Fujifilm RAF embeds. Imported only from
// *.browser.test.ts files.

const EXIF_SIGNATURE = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];

/** A little-endian TIFF with one IFD0 entry: Orientation (0x0112). */
function orientationTiff(orientation: number): number[] {
  return [
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, // II, 42, IFD0 at 8
    0x01, 0x00, // one entry
    0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, // 0x0112, SHORT, count 1
    orientation, 0x00, 0x00, 0x00, // value, inline
    0x00, 0x00, 0x00, 0x00, // no next IFD
  ];
}

export async function taggedJpeg(
  width: number,
  height: number,
  orientation: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ff0000";
  ctx.fillRect(0, 0, width / 2, height);
  ctx.fillStyle = "#0000ff";
  ctx.fillRect(width / 2, 0, width / 2, height);
  const encoded = await canvas.convertToBlob({ type: "image/jpeg", quality: 1 });
  const plain = new Uint8Array(await encoded.arrayBuffer());

  const payload = [...EXIF_SIGNATURE, ...orientationTiff(orientation)];
  const length = payload.length + 2;
  const app1 = [0xff, 0xe1, length >> 8, length & 0xff, ...payload];
  const out = new Uint8Array(plain.length + app1.length);
  out.set(plain.subarray(0, 2));
  out.set(app1, 2);
  out.set(plain.subarray(2), 2 + app1.length);
  return out;
}

export interface Corners {
  size: string;
  topLeft: string;
  topRight: string;
  bottomLeft: string;
}

/** Which of the two colours sits in each corner of a decoded image, and its
 *  size — enough to tell sensor-native from upright from squashed. */
export async function corners(source: Blob | ImageBitmap): Promise<Corners> {
  const bitmap = source instanceof ImageBitmap ? source : await createImageBitmap(source);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  const at = (x: number, y: number): string => {
    const [r, , b] = ctx.getImageData(x, y, 1, 1).data;
    if (r > 128 && b < 128) return "red";
    if (b > 128 && r < 128) return "blue";
    return `neither (r ${r}, b ${b})`;
  };
  const inset = 2;
  return {
    size: `${bitmap.width}x${bitmap.height}`,
    topLeft: at(inset, inset),
    topRight: at(bitmap.width - 1 - inset, inset),
    bottomLeft: at(inset, bitmap.height - 1 - inset),
  };
}
