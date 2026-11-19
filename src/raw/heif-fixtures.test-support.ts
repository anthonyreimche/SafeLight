// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Two small HEIC files written by libheif (pillow-heif), lossless 4:4:4,
// 64 × 48 in quadrants: top left red, top right green, bottom left blue,
// bottom right 50 % grey.
//
// srgb8 (8-bit per pixi, though libheif hands its RRGGBB out at 10 bits)
// carries an Exif item (Make Apple, Model "iPhone 15 Pro",
// DateTimeOriginal 2026:05:04 13:14:15, ISO 125, Orientation 6) and the
// orientation as irot, so it decodes 48 × 64: top left blue, top right red,
// bottom left grey, bottom right green.
//
// p3_10 is 10-bit with NCLX primaries 12 (Display P3), transfer 13 (sRGB),
// matrix 0, full range.

export const HEIF_SRGB8 =
  "AAAAHGZ0eXBoZWl4AAAAAG1pZjFoZWl4bWlhZgAAAcltZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAA" +
  "AAAAADRpbG9jAAAAAERAAAIAAQAAAAAB7QABAAAAAAAAA4kAAgAAAAAFdgABAAAAAAAAAI4AAAA4aWluZgAAAAAAAgAAABVp" +
  "bmZlAgAAAAABAABodmMxAAAAABVpbmZlAgAAAQACAABFeGlmAAAAAA5waXRtAAAAAAABAAABCGlwcnAAAADnaXBjbwAAAHdo" +
  "dmNDAQQIAAAAnjgAAAAA//AA/P/4+AAADwNgAAEAF0ABDAH//wQIAAADAJ44AAADAAD/ugJAYQABACpCAQEECAAAAwCeOAAA" +
  "AwAA/5AEECCy3VyU1zcBDQYEAAADAGQAAAMABCBiAAEACEQBwXAwYJEgAAAAE2NvbHJuY2x4AAEADQAGgAAAABRpc3BlAAAA" +
  "AAAAAEAAAABAAAAAKGNsYXAAAABAAAAAAQAAADAAAAABAAAAAAAAAAL////wAAAAAgAAABBwaXhpAAAAAAMICAgAAAAJaXJv" +
  "dAMAAAAZaXBtYQAAAAAAAAABAAEGgQIDBYSGAAAAGmlyZWYAAAAAAAAADmNkc2MAAgABAAEAAAQfbWRhdAAAA4UoAa8FuB9s" +
  "Y7///qt1IoPo55eXl5gJiYmJiYmJNr//+RO1//+rYU8R88WLFixkqVKlSpUmif/se6AH/df7n+1/W/O/O/O/O/PfPfPfPfPf" +
  "PfPfPXgTMVsSxCyhy8qn7hgtKzf/+3Ha3YGcOHDhxDhw4cOHDdiY19+gCB5FLyGTHYIqwCkApAKQCkAxIMSDEgxIMSDEgxIK" +
  "f3xrt///Gz+NJYs9Dtdpdpdpdpd4t4t4t4t4t4t4tpxff/9YzgzDqLULXALib2eFGZGZgf/9XDdylik5lR4ebFsUVqYv/+4q" +
  "Fc0qSkQPWBkpCTNF5XQAAG+z8S9jtasBQFAD+h6ySgR//xgHGGlD3wpmMZKf7XKnV//xZG6EsleGRRtktHSwRQleX//K0kpt" +
  "JJILUd9o27oOc///+y97rSxlt0es+8xBTjsBnLgAKGyy2RRfPdJSlKUpSly3Lcty3Lcty0/LiZP//mai/SFYMGDBg+XLly5c" +
  "uRgbKx///FWOJ7obiAZGkxpMaTGkxqt6req3qt6req3qt6YMAAX6F7T05LV19wJOgyrrQOSsvXJIAA5hyQttRlSj2l2M659G" +
  "FCZBuABGeleLHQjbuatQiHVaFgfd1Uus7KAAvUTut6BKckI4nmDkTxmxntOABHU04LbGaY5eBTiFLkNTpKxng4zvZyOxH/+u" +
  "K2jrLLLLMm222221pq/9//2vM1xpppppzrrrrrrjaWvgGJIljhQbke7u7u71HR0dHR0dF7M//1qGlcIIIIITttttttj8ADFY" +
  "jHO7uB5ULLSUXOV/tTB5q9aH//8JYBU000005JJJJJJGKn/+ys/8d9999/Ukkkkkkg6sAB6hmZQWmPayAWS0Ln//amSjc888" +
  "89m222222aE//0EjTKWWWWWjttttttsxB//+slTRZZZZZa22222215j//gJuDbLLLLLu2222222Bhahu//8RtGfE1DbaQ27M" +
  "QRJWH/EBHKBAgBTfUBhjHlz9dncMVIu9c8Aj8vIAQEyX+6cHL0bk60z1KwtBbbXOL9mAIYUzctGeCkI6z//u8Trz+DOetABs" +
  "qSCXaaTyn37i+R9OscffG2x9Q04AN1PElye0gQHvOBQ1W9hquFaoWAGAzF4yVwevXiy7ElCDZKELSnIWQAKp3tqcUHvRomm/" +
  "R+xjQce1HOgACRi6NvNpstfry/SP1Pkogx4vizBYAAAABkV4aWYAAE1NACoAAAAIAAQBDwACAAAABgAAAD4BEAACAAAADgAA" +
  "AEQBEgADAAAAAQAGAACHaQAEAAAAAQAAAFIAAAAAQXBwbGUAaVBob25lIDE1IFBybwAAAognAAMAAAABAH0AAJADAAIAAAAU" +
  "AAAAcAAAAAAyMDI2OjA1OjA0IDEzOjE0OjE1AA==";

export const HEIF_P3_10 =
  "AAAAHGZ0eXBoZWl4AAAAAG1pZjFoZWl4bWlhZgAAAX1tZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAA" +
  "AAAAACJpbG9jAAAAAERAAAEAAQAAAAABoQABAAAAAAAAAakAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABodmMxAAAA" +
  "AA5waXRtAAAAAAABAAAA/WlwcnAAAADdaXBjbwAAAHZodmNDAQQIAAAAnDgAAAAA//AA/P/6+gAADwNgAAEAF0ABDAH//wQI" +
  "AAADAJw4AAADAAD/ugJAYQABAClCAQEECAAAAwCcOAAAAwAA/5AEECCbLdXJTXNwwNAAQAAABkAAAAMAQmIAAQAIRAHBcDBg" +
  "kSAAAAATY29scm5jbHgADAANAACAAAAAFGlzcGUAAAAAAAAAQAAAAEAAAAAoY2xhcAAAAEAAAAABAAAAMAAAAAEAAAAAAAAA" +
  "Av////AAAAACAAAAEHBpeGkAAAAAAwoKCgAAABhpcG1hAAAAAAAAAAEAAQWBAgMFhAAAAbFtZGF0AAABpSgBrwW4H2xjv///" +
  "4y58YkMVBIb1/93/3f/d/94AT4BPgE+AT4BPgE+AT3/wv//5E7X///n4Pz5JztRmrCUwJTAlMCUwJUflR+VH5UflR+VH5Ufl" +
  "NOf/se6AH/31/75/71/3b/bv9u/27/bv9vf29/b39vf29/b39vf29eBMxWxLELKHLyqftqo4wU5ftTEAWf0o9+k8fpD30Wr0" +
  "AL0AL0AL0AL0Bl0Bl0Bl0Bl0Bl0Bl0Bl0ARv81+///8JnfhJH4Od8Da77y77y77y77y78Rb8Rb8Rb8Rb8Rb8Rb8Rb76ubigk" +
  "SfZiDtAM/5b7/LY/yvv5RX5EX5EX5EX5EX5FL5FL5FL5FL5FL5FL5FL5EcG4mT///x/U+PsvjtTxoxxNBxNBxNBxNBxOwxOw" +
  "xOwxOwxOwxOwxOwxOAIMg/XRJ4I/9sTB62Efmj+i19CPOiuQl9V5QALAX/egAyf4A5/E3fiUfh3fB675Lvku+S75LvoW+hb6" +
  "FvoW+hb6FvoW+WGAAA7OE3qTPSv91AKgR89j++xQrG5LXHavF978J5CsKkt0dub/YUQ=";

export function heifBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export const heifBlob = (base64: string): Blob => new Blob([heifBytes(base64)]);
