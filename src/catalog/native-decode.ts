// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A photo's RAW decoded at full size for the detail overlay, with none of
// loadPhotoImage's side effects: it writes no RAW-cache entry, no decode marker
// and nothing on the photo, and reads no camera preview. It never turns a frame
// on the main thread, so a frame the decoder left unturned is not used.

import type { CatalogPhoto } from "./types";
import { isRawFile } from "@/raw/raw-preview";
import { decodeRawToFloat } from "@/raw/decode";
import type { DecodeRequest } from "@/raw/decode-pool";
import { encodeFrameLuma } from "@/raw/frame-bridge";
import { NATIVE_FRAME_MAX_PIXELS } from "@/raw/native-frame";
import { isSourceFile, sourceOriginalHeld } from "@/project/library-sources";
import { manualRotation, normalizeRotation } from "./orient";
import { verifyPermission } from "./permissions";

/** A photo's RAW decoded at full size: half-float linear luminance, one per pixel, rows top-down, oriented as Develop's source. */
export interface NativeDecode {
  data: Uint16Array<ArrayBuffer>;
  width: number;
  height: number;
}

/** Why no frame came back: "retry" when the decoder passed the request over or failed in passing, "never" when this photo cannot give one. */
export type NativeDecodeMiss = { miss: "retry" | "never" };

const RETRY: NativeDecodeMiss = { miss: "retry" };
const NEVER: NativeDecodeMiss = { miss: "never" };

/** The photo's RAW at its full size. A library source's original that is not
 *  kept on disk is never fetched, and access to the original is not asked for. */
export async function decodeNativeFrame(
  photo: CatalogPhoto,
  opts: { signal: AbortSignal; background: boolean },
): Promise<NativeDecode | NativeDecodeMiss> {
  const { signal, background } = opts;
  const handle = photo.fileHandle;
  if (signal.aborted) return RETRY;
  if (!isRawFile({ name: photo.filename } as File) || !handle) return NEVER;
  if (isSourceFile(handle) && !(await sourceOriginalHeld(handle))) return signal.aborted ? RETRY : NEVER;
  if (!(await verifyPermission(handle))) return signal.aborted ? RETRY : NEVER;
  if (signal.aborted) return RETRY;

  let file: File;
  try {
    file = await handle.getFile();
  } catch {
    return signal.aborted ? RETRY : NEVER;
  }
  if (signal.aborted) return RETRY;

  const turn = manualRotation(photo.rotation ?? 0, photo.exif?.orientation);
  const request: DecodeRequest = { background, signal, ...(turn ? { turn } : {}) };
  try {
    const f = await decodeRawToFloat(file, request, photo.relPath);
    if (signal.aborted) return RETRY;
    if ("failure" in f) return f.passedOver || f.failure !== "unsupported" ? RETRY : NEVER;
    const unturned = normalizeRotation(turn - (f.turned ?? 0));
    if (!f.oriented || unturned !== 0 || f.halfSize || f.suspicious) return NEVER;
    if (f.width * f.height > NATIVE_FRAME_MAX_PIXELS) return NEVER;

    const data = await encodeFrameLuma(f.data, { background, signal });
    return signal.aborted ? RETRY : { data, width: f.width, height: f.height };
  } catch {
    return RETRY;
  }
}
