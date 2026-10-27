// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Reads an Adobe DNG camera profile (DCP): a TIFF-structured file with "IIRC"
// or "MMCR" for a header, holding one profile's DNG tags in its first IFD.

import type { PackableProfile } from "../../src/rendering/camera-profiles/format.ts";
import { readHeader, readIfd, type TagValue } from "./tiff.ts";

/** "RC" after the byte-order mark. */
export const DCP_MAGIC = 0x4352;

const TAG = {
  UniqueCameraModel: 0xc614,
  ColorMatrix1: 0xc621,
  ColorMatrix2: 0xc622,
  CalibrationIlluminant1: 0xc65a,
  CalibrationIlluminant2: 0xc65b,
  ProfileName: 0xc6f8,
  ProfileHueSatMapDims: 0xc6f9,
  ProfileHueSatMapData1: 0xc6fa,
  ProfileHueSatMapData2: 0xc6fb,
  ProfileToneCurve: 0xc6fc,
  ProfileEmbedPolicy: 0xc6fd,
  ProfileCopyright: 0xc6fe,
  ForwardMatrix1: 0xc714,
  ForwardMatrix2: 0xc715,
  ProfileLookTableDims: 0xc725,
  ProfileLookTableData: 0xc726,
  ProfileHueSatMapEncoding: 0xc7a3,
  ProfileLookTableEncoding: 0xc7a4,
  BaselineExposureOffset: 0xc7a5,
  DefaultBlackRender: 0xc7a6,
} as const;

export interface ParsedDcp extends PackableProfile {
  /** The camera the profile is for, as Adobe spells it. */
  uniqueCameraModel: string;
}

/** The profile in a DCP. Throws when the bytes aren't a DCP. */
export function parseDcp(bytes: Uint8Array): ParsedDcp {
  const head = readHeader(bytes, DCP_MAGIC);
  if (!head) throw new Error("not a DNG camera profile");
  const tags = readIfd(bytes, head.ifd, head.littleEndian);
  // Every DCP has one; without it the profile can't map camera colour at all.
  if (!tags.has(TAG.ColorMatrix1)) throw new Error("no ColorMatrix1");
  const nums = (tag: number): number[] => {
    const v: TagValue | undefined = tags.get(tag);
    return Array.isArray(v) ? v : [];
  };
  // ProfileName and ProfileCopyright may be ASCII or UTF-8 bytes.
  const str = (tag: number): string => {
    const v = tags.get(tag);
    if (typeof v === "string") return v;
    return v ? new TextDecoder().decode(Uint8Array.from(v)).replace(/\0+$/, "") : "";
  };
  const first = (tag: number): number => nums(tag)[0] ?? 0;
  // A missing matrix reads as zeros (ColorMatrix2 and the forward matrices are
  // often left out). One that's present with the wrong count is refused:
  // zeros would pass for a valid matrix further down.
  const matrix = (tag: number, label: string): Float32Array => {
    const v = tags.get(tag);
    if (v === undefined) return new Float32Array(9);
    if (!Array.isArray(v)) throw new Error(`${label} is text, not 9 numbers`);
    if (v.length !== 9) throw new Error(`${label} has ${v.length} values, not 9`);
    return Float32Array.from(v);
  };
  const dims = (tag: number): [number, number, number] => {
    const v = nums(tag);
    return v.length === 3 ? [v[0], v[1], v[2]] : [0, 0, 0];
  };
  const policy = nums(TAG.ProfileEmbedPolicy);
  return {
    uniqueCameraModel: str(TAG.UniqueCameraModel),
    name: str(TAG.ProfileName),
    copyright: str(TAG.ProfileCopyright),
    embedPolicy: policy.length > 0 ? policy[0] : null,
    illuminant1: first(TAG.CalibrationIlluminant1),
    illuminant2: first(TAG.CalibrationIlluminant2),
    colorMatrix1: matrix(TAG.ColorMatrix1, "ColorMatrix1"),
    colorMatrix2: matrix(TAG.ColorMatrix2, "ColorMatrix2"),
    forwardMatrix1: matrix(TAG.ForwardMatrix1, "ForwardMatrix1"),
    forwardMatrix2: matrix(TAG.ForwardMatrix2, "ForwardMatrix2"),
    exposureOffset: first(TAG.BaselineExposureOffset),
    defaultBlackRender: first(TAG.DefaultBlackRender),
    hueSatEncoding: first(TAG.ProfileHueSatMapEncoding),
    lookEncoding: first(TAG.ProfileLookTableEncoding),
    hueSatDims: dims(TAG.ProfileHueSatMapDims),
    hueSat1: Float32Array.from(nums(TAG.ProfileHueSatMapData1)),
    hueSat2: Float32Array.from(nums(TAG.ProfileHueSatMapData2)),
    lookDims: dims(TAG.ProfileLookTableDims),
    look: Float32Array.from(nums(TAG.ProfileLookTableData)),
    toneCurve: Float32Array.from(nums(TAG.ProfileToneCurve)),
  };
}
