// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The camera profile tables' file format (public/camera-profiles/*.slcp, each
// a gzip of these bytes): the parts of an Adobe DNG camera profile (DCP) that
// rendering needs. build-scripts/camera-profiles writes it with
// packCameraProfiles; the renderer reads it with parseCameraProfiles. Both sit
// here so they can't drift apart. Little-endian throughout:
//
//   "SLCP", u16 format, u16 profile count, then for each profile:
//   name, copyright (u16 byte length + UTF-8 each); illuminant1, illuminant2
//   (u16); colorMatrix1, colorMatrix2, forwardMatrix1, forwardMatrix2 (9 × f32
//   each, zeros when absent); exposureOffset (f32); defaultBlackRender,
//   hueSatEncoding, lookEncoding (u16); hueSatDims (3 × u16); the number of
//   hue/sat maps (u16: 0, 1 or 2), each dims product × 3 × f16; lookDims
//   (3 × u16) and, when they aren't zero, the look table (product × 3 × f16);
//   the tone curve's point count (u16), then count × 2 × f32.
//
// Matrices and the tone curve stay f32 for shadow precision. The tables are
// f16: hue shifts in degrees and saturation and value scales keep well under
// 0.1° and 0.1% in half floats. The build tool runs this file under Node's type
// stripping, so its one import carries the .ts extension.

import { encodeHalf, halfToFloat32 } from "../../raw/half-float.ts";

export const CAMERA_PROFILE_FORMAT = 1;
const MAGIC = "SLCP";

export interface CameraProfile {
  name: string;
  copyright: string;
  /** EXIF LightSource codes of the two calibrations; 0 for the second when there is one. */
  illuminant1: number;
  illuminant2: number;
  /** Row-major 3 × 3; all zeros when the profile has none. */
  colorMatrix1: Float32Array;
  colorMatrix2: Float32Array;
  forwardMatrix1: Float32Array;
  forwardMatrix2: Float32Array;
  /** BaselineExposureOffset, in EV. */
  exposureOffset: number;
  /** DefaultBlackRender: 0 auto, 1 none. */
  defaultBlackRender: number;
  /** ProfileHueSatMapEncoding and ProfileLookTableEncoding: 0 linear, 1 sRGB. */
  hueSatEncoding: number;
  lookEncoding: number;
  /** Hue, saturation and value divisions; [0, 0, 0] without a map. */
  hueSatDims: [number, number, number];
  /** Per entry: hue shift in degrees, saturation scale, value scale. Empty without a map. */
  hueSat1: Float32Array;
  /** The second calibration's map; empty when there is one map or none. */
  hueSat2: Float32Array;
  lookDims: [number, number, number];
  look: Float32Array;
  /** Input/output pairs in linear light; empty without a curve. */
  toneCurve: Float32Array;
}

/** A profile as the build tool holds it, with the embed policy it came under. */
export interface PackableProfile extends CameraProfile {
  /** ProfileEmbedPolicy; null when the DCP had none. */
  embedPolicy: number | null;
}

const tableSize = (dims: readonly number[]): number => dims[0] * dims[1] * dims[2] * 3;

function checkProfile(p: PackableProfile): void {
  if (p.embedPolicy !== 0) {
    throw new Error(`${p.name}: embed policy ${p.embedPolicy} does not allow copying`);
  }
  for (const m of [p.colorMatrix1, p.colorMatrix2, p.forwardMatrix1, p.forwardMatrix2]) {
    if (m.length !== 9) throw new Error(`${p.name}: a matrix has ${m.length} values, not 9`);
  }
  // The writer packs the non-empty maps in order, so a second map without a
  // first would be read back as the first.
  if (p.hueSat1.length === 0 && p.hueSat2.length > 0) {
    throw new Error(`${p.name}: a second hue/sat map without a first one`);
  }
  for (const map of [p.hueSat1, p.hueSat2]) {
    if (map.length !== 0 && map.length !== tableSize(p.hueSatDims)) {
      throw new Error(`${p.name}: a hue/sat map has ${map.length} values for dims ${p.hueSatDims.join("×")}`);
    }
  }
  if (p.look.length !== tableSize(p.lookDims)) {
    throw new Error(`${p.name}: the look table has ${p.look.length} values for dims ${p.lookDims.join("×")}`);
  }
  if (p.toneCurve.length % 2 !== 0) throw new Error(`${p.name}: the tone curve has an odd value count`);
}

class Writer {
  private readonly parts: Uint8Array[] = [];

  bytes(b: Uint8Array): void {
    this.parts.push(b);
  }

  u16(v: number): void {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v, true);
    this.parts.push(b);
  }

  f32s(values: ArrayLike<number>): void {
    const b = new Uint8Array(values.length * 4);
    const view = new DataView(b.buffer);
    for (let i = 0; i < values.length; i++) view.setFloat32(i * 4, values[i], true);
    this.parts.push(b);
  }

  f16s(values: Float32Array): void {
    const half = encodeHalf(values);
    const b = new Uint8Array(half.length * 2);
    const view = new DataView(b.buffer);
    for (let i = 0; i < half.length; i++) view.setUint16(i * 2, half[i], true);
    this.parts.push(b);
  }

  text(s: string): void {
    const b = new TextEncoder().encode(s);
    this.u16(b.length);
    this.parts.push(b);
  }

  done(): Uint8Array {
    const out = new Uint8Array(this.parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of this.parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
}

/** The uncompressed table for one camera's profiles. Throws on a profile whose
 *  embed policy isn't 0, or whose tables don't fit their dimensions. */
export function packCameraProfiles(profiles: readonly PackableProfile[]): Uint8Array {
  const w = new Writer();
  w.bytes(new TextEncoder().encode(MAGIC));
  w.u16(CAMERA_PROFILE_FORMAT);
  w.u16(profiles.length);
  for (const p of profiles) {
    checkProfile(p);
    w.text(p.name);
    w.text(p.copyright);
    w.u16(p.illuminant1);
    w.u16(p.illuminant2);
    for (const m of [p.colorMatrix1, p.colorMatrix2, p.forwardMatrix1, p.forwardMatrix2]) w.f32s(m);
    w.f32s([p.exposureOffset]);
    w.u16(p.defaultBlackRender);
    w.u16(p.hueSatEncoding);
    w.u16(p.lookEncoding);
    for (const d of p.hueSatDims) w.u16(d);
    const maps = [p.hueSat1, p.hueSat2].filter((m) => m.length > 0);
    w.u16(maps.length);
    for (const m of maps) w.f16s(m);
    for (const d of p.lookDims) w.u16(d);
    if (p.look.length > 0) w.f16s(p.look);
    w.u16(p.toneCurve.length / 2);
    w.f32s(p.toneCurve);
  }
  return w.done();
}

/** The profiles in an uncompressed table. Throws on bytes that aren't one, or
 *  a format this build doesn't know. */
export function parseCameraProfiles(bytes: Uint8Array): CameraProfile[] {
  if (bytes.length < 8 || new TextDecoder().decode(bytes.subarray(0, 4)) !== MAGIC) {
    throw new Error("not a camera profile table");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 4;
  const u16 = (): number => {
    const v = view.getUint16(at, true);
    at += 2;
    return v;
  };
  const f32s = (n: number): Float32Array => {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++, at += 4) out[i] = view.getFloat32(at, true);
    return out;
  };
  const f16s = (n: number): Float32Array => {
    const half = new Uint16Array(n);
    for (let i = 0; i < n; i++, at += 2) half[i] = view.getUint16(at, true);
    return halfToFloat32(half);
  };
  const text = (): string => {
    const n = u16();
    const s = new TextDecoder().decode(bytes.subarray(at, at + n));
    at += n;
    return s;
  };
  const dims = (): [number, number, number] => [u16(), u16(), u16()];

  const format = u16();
  if (format !== CAMERA_PROFILE_FORMAT) {
    throw new Error(`camera profile table format ${format}; this build reads ${CAMERA_PROFILE_FORMAT}`);
  }
  const count = u16();
  const profiles: CameraProfile[] = [];
  for (let k = 0; k < count; k++) {
    const name = text();
    const copyright = text();
    const illuminant1 = u16();
    const illuminant2 = u16();
    const colorMatrix1 = f32s(9);
    const colorMatrix2 = f32s(9);
    const forwardMatrix1 = f32s(9);
    const forwardMatrix2 = f32s(9);
    const exposureOffset = f32s(1)[0];
    const defaultBlackRender = u16();
    const hueSatEncoding = u16();
    const lookEncoding = u16();
    const hueSatDims = dims();
    const maps = u16();
    const hueSat1 = maps > 0 ? f16s(tableSize(hueSatDims)) : new Float32Array(0);
    const hueSat2 = maps > 1 ? f16s(tableSize(hueSatDims)) : new Float32Array(0);
    const lookDims = dims();
    const look = tableSize(lookDims) > 0 ? f16s(tableSize(lookDims)) : new Float32Array(0);
    const toneCurve = f32s(u16() * 2);
    profiles.push({
      name,
      copyright,
      illuminant1,
      illuminant2,
      colorMatrix1,
      colorMatrix2,
      forwardMatrix1,
      forwardMatrix2,
      exposureOffset,
      defaultBlackRender,
      hueSatEncoding,
      lookEncoding,
      hueSatDims,
      hueSat1,
      hueSat2,
      lookDims,
      look,
      toneCurve,
    });
  }
  return profiles;
}
