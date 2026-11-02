// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

export interface RawFloatImage {
  data: Float32Array; // linear RGBA, row-major, top-left origin
  width: number;
  height: number;
  oriented?: boolean;   // true when the decoder already applied EXIF orientation
  suspicious?: boolean; // true when the decode passed sanity checks but was marginal
                        // — do not write to cache, let the next open re-decode
  colorTemperature?: number; // as-shot WB in Kelvin, derived from camera multipliers
  rawExposureBias?: number;  // EV the sensor sat below the tagged ISO (Fujifilm DR modes), compensated in `data`
  halfSize?: boolean;        // decoded at half the frame's width and height: at full size it
                             // needs more memory than libraw's heap holds
}

/**
 * Why a float decode produced no image. `unsupported`: the file was read and
 * nothing usable came of it, so reading it again won't help until the decoder
 * changes. `transient`: the decoder or the file wasn't available this time.
 * `aborted`: the request was abandoned (see DecodeRequest).
 */
export interface DecodeFailure {
  failure: "unsupported" | "transient" | "aborted";
  /** Why, in the decoder's words, for the grid's warning and Develop's status
   *  line. An abandoned request has none: nobody is waiting to learn it. */
  reason?: string;
  /** libraw gave no answer within its time limit (see decodeTimeLimit). */
  timedOut?: boolean;
  /** Unsupported because the frame ran libraw out of memory even at half
   *  size: decoding it again would only do the same. */
  tooLarge?: boolean;
  /** Background work passed the file over (see decodeRawToFloat): its decode
   *  is running elsewhere or ran out of time. Nothing is wrong with the file,
   *  so nothing should stand in for its decode. */
  passedOver?: boolean;
}
