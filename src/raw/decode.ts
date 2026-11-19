// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// RAW decode orchestrator. Decodes a RAW file to a full-precision linear float
// image (decodeRawToFloat) or an 8-bit bitmap (decodeRawToBitmap). The float
// decode walks the decoders the person ordered for the file's format
// (catalog/image-decoders.ts), and the first to give an image wins:
//
//   - core's: libraw (handles everything, best colour science), and behind it
//     the in-house decoder for uncompressed CFA data (TIFF-based RAW / DNG);
//   - an extension's (api.library.registerDecoder): its linear frame is
//     finished as libraw's is, off the main thread (frame-job.ts).
//
// When none gives one the float decode says why (DecodeFailure) and the caller
// falls back to the embedded JPEG preview. The bitmap decode is the in-house
// decoder alone, and leaves a file an extension's decoder leads for to the
// float decode.
//
// Compressed sensor data (e.g. Nikon NEF lossless) needs libraw; without it the
// preview is shown, so RAW files always display.

import {
  TiffReader,
  findRawIfd,
  TIFF_TAG,
  COMPRESSION,
  type Ifd,
  type RawIfdInfo,
} from "./tiff";
import {
  developRawPlane,
  developRawPlaneFloat,
  linearizeSamples,
  unpackSamples,
  type DevelopOptions,
} from "./pixels";
import { MAX_DECODE_PIXELS } from "./decode-limits";
import { decodeRawFloatViaLibRaw } from "./libraw-wasm-adapter";
import { finishLinearFrame, isAbandoned } from "./frame-bridge";
import type { BuiltFrame } from "./frame-job";
import { decoderMarkerId } from "./raw-cache";
import {
  chainSignature,
  decoderChain,
  formatOf,
  runExtensionDecoder,
  type ChainEntry,
  type ExtensionChainEntry,
} from "@/catalog/image-decoders";
import { normalizeRotation, orientationToRotation } from "@/catalog/orient";
import type { DecodedImageResult } from "@/extensions/api/library";
import type { DecodeRequest } from "./decode-pool";
import type { DecodeFailure, RawFloatImage } from "./decode-result";

export type { DecodeFailure, RawFloatImage };

/** What a float decode is asked: libraw's request, and what the file's other
 *  decoders take besides. */
export interface RawDecodeRequest extends DecodeRequest {
  /** The photo's as-shot white balance multipliers, green at 1, when known:
   *  an extension's decoder balances the frame by them. */
  asShotMultipliers?: readonly [number, number, number];
  /** The photo's EXIF orientation tag, when it has one: an extension's frame
   *  that isn't upright is turned upright by it along with `turn`, so the frame
   *  and its cache entry come out as libraw's do. */
  orientation?: number;
  /** Decoders whose final verdict on the file is "unsupported", by marker id
   *  (raw-cache.ts decoderMarkerId): the decode passes them by. */
  ruledOut?: ReadonlySet<string>;
}

const DEFAULT_CFA: [number, number, number, number] = [0, 1, 1, 2]; // RGGB

// A file a decoder gave no answer for holds that decoder for its whole time
// limit, so background work (the "Cache all" pass, the preview repair,
// Develop's prefetch) asks that decoder about it once a session; the file's
// other decoders are still asked. Background work also leaves a file alone
// while any decode of it is under way, which fills the cache itself. A photo
// the user opens is always decoded. A file is told apart by its path (its name
// when the caller gives none), size and modification time, and a decoder's
// answers by the file and the decoder (answerKey). Only the latest unanswered
// ones are kept; one that later decodes is forgotten.
const UNANSWERED_LIMIT = 256;
const decoding = new Map<string, number>();
const unanswered = new Set<string>();

type Decoded = RawFloatImage | DecodeFailure;

// A decode under way, by file. Its caller may leave while libraw runs (Develop
// prefetches the next photo for the one that is open, and leaving that one
// abandons the prefetch); libraw can't be stopped, so the decode would end for
// nobody. A photo opened meanwhile takes it over instead of decoding the file
// again from the start. Only a decode nobody waits for is taken over: its
// frame's buffers go to one caller. An extension's decoder is stopped when its
// caller leaves, so a decode taken over then answers "aborted" and the photo
// decodes for itself.
interface Flight {
  /** What was asked of the decode, as far as its frame depends on it. */
  asked: string;
  /** The caller it began for. */
  signal: AbortSignal | undefined;
  /** The caller that took it over, and how it is answered. */
  heir: { signal: AbortSignal | undefined; answer: (decoded: Decoded) => void } | null;
}
const flights = new Map<string, Flight>();

const ABORTED: DecodeFailure = { failure: "aborted" };

const LIBRAW: ChainEntry = { id: "libraw", owner: "core", label: "Built-in" };

/** What a decode by `chain` is asked, as far as its frame depends on it: an
 *  extension's decoder among the chain's makes it depend on the decoders and
 *  the photo's orientation too. */
function askedOf(request: RawDecodeRequest | undefined, chain: RawChain): string {
  const asked = [request?.targetEdge ?? 0, request?.turn ?? 0, request?.cacheEdge ?? 0].join(":");
  if (!chain.entries.some(isExtension)) return asked;
  return `${asked}:${orientationToRotation(request?.orientation)}:${chain.signature}`;
}

/** Whether nobody waits on a decode any more: its caller has left, and no other
 *  has taken it over. */
function abandoned(request: DecodeRequest | undefined): boolean {
  if (!request?.signal?.aborted) return false;
  const heir = request.heir?.();
  return !heir || !!heir.signal?.aborted;
}

/** The decode of file `id` that `request` takes over, if one is running for
 *  nobody and makes the frame it asks for: its answer, once it has one. */
function takeOver(id: string, request: RawDecodeRequest | undefined, chain: RawChain): Promise<Decoded> | null {
  const flight = flights.get(id);
  if (!flight?.signal?.aborted || flight.asked !== askedOf(request, chain)) return null;
  if (flight.heir && !flight.heir.signal?.aborted) return null;
  flight.heir?.answer(ABORTED);
  return new Promise((answer) => {
    flight.heir = { signal: request?.signal, answer };
  });
}

function fileId(file: Blob, path?: string): string | undefined {
  return file instanceof File
    ? `${path ?? file.name}:${file.size}:${file.lastModified}`
    : undefined;
}

const isExtension = (entry: ChainEntry): entry is ExtensionChainEntry => "decoder" in entry;

/** How the answers of `entry` on file `id` are remembered: libraw's under the
 *  file's id alone. */
function answerKey(id: string, entry: ChainEntry): string {
  return isExtension(entry) ? `${id}|${decoderMarkerId(entry)}` : id;
}

function markUnanswered(key: string): void {
  unanswered.delete(key);
  unanswered.add(key);
  if (unanswered.size > UNANSWERED_LIMIT) {
    const oldest = unanswered.values().next().value;
    if (oldest !== undefined) unanswered.delete(oldest);
  }
}

/** The decoders that read a RAW, in the person's order, and their signature
 *  (image-decoders.ts chainSignature): "" while libraw leads. */
interface RawChain {
  entries: readonly ChainEntry[];
  signature: string;
}

/** The decoders that read the RAW named `name`; libraw alone for a name no RAW
 *  format claims. */
function rawChain(name: string): RawChain {
  const format = formatOf(name);
  const entries = format?.raw ? decoderChain(format.id) : [];
  if (!format?.raw || entries.length === 0) return { entries: [LIBRAW], signature: "" };
  return { entries, signature: chainSignature(format.id) };
}

// Decode to a full-precision LINEAR float image, for the high-bit-depth editing
// pipeline, by the file's decoders in turn (see the header). When none yields
// an image, the caller falls back to the camera's embedded preview. `path`: the
// photo's, which names its format and tells files apart. `bytes`: the file's,
// for a caller that goes on using them, either read already or read by the
// function given, which is called only once libraw's decode goes ahead; they
// are left intact.
export async function decodeRawToFloat(
  file: Blob,
  request?: RawDecodeRequest,
  path?: string,
  bytes?: ArrayBuffer | (() => Promise<ArrayBuffer>),
): Promise<RawFloatImage | DecodeFailure> {
  if (request?.signal?.aborted) return { failure: "aborted" };
  const name = path ?? (file instanceof File ? file.name : "");
  const chain = rawChain(name);
  const ruledOut = request?.ruledOut;
  const tried = ruledOut ? chain.entries.filter((entry) => !ruledOut.has(decoderMarkerId(entry))) : chain.entries;
  const decoders = { tried, extended: chain.entries.some(isExtension), signature: chain.signature };
  const id = fileId(file, path);
  if (id === undefined) return decodeFloat(file, name, decoders, request, undefined, bytes);
  if (request?.background) {
    const reason = tried.length > 0 && tried.every((entry) => unanswered.has(answerKey(id, entry)))
      ? "no answer earlier this session"
      : decoding.has(id)
        ? "being decoded already"
        : undefined;
    if (reason) return { failure: "transient", reason, passedOver: true };
  } else {
    const taken = takeOver(id, request, chain);
    if (taken) {
      const decoded = await taken;
      // A decode still waiting for a decoder when its caller left has left the
      // queue with it: this request decodes for itself after all.
      const dropped = "failure" in decoded && decoded.failure === "aborted";
      if (!dropped || request?.signal?.aborted) return decoded;
    }
  }
  const flight: Flight = { asked: askedOf(request, chain), signal: request?.signal, heir: null };
  // Of two decodes of one file begun side by side, the first is the one to take over.
  if (!flights.has(id)) flights.set(id, flight);
  decoding.set(id, (decoding.get(id) ?? 0) + 1);
  try {
    const decoded = await decodeFloat(file, name, decoders, { ...request, heir: () => flight.heir }, id, bytes);
    if (!flight.heir) return decoded;
    flight.heir.answer(flight.heir.signal?.aborted ? ABORTED : decoded);
    return ABORTED;
  } finally {
    if (flights.get(id) === flight) flights.delete(id);
    const left = (decoding.get(id) ?? 1) - 1;
    if (left > 0) decoding.set(id, left);
    else decoding.delete(id);
  }
}

/** The file by the decoders `tried`. While libraw's is the file's only
 *  decoder the answer is libraw's as it gave it; once an extension's is among
 *  them (`extended`), an image names the decoder that made it and the chain's
 *  `signature`, and a failure each decoder that found nothing usable. */
async function decodeFloat(
  file: Blob,
  name: string,
  { tried: chain, extended, signature }: { tried: readonly ChainEntry[]; extended: boolean; signature: string },
  request: RawDecodeRequest | undefined,
  id: string | undefined,
  bytes: ArrayBuffer | (() => Promise<ArrayBuffer>) | undefined,
): Promise<RawFloatImage | DecodeFailure> {
  if (chain.length === 0) {
    return { failure: "unsupported", reason: "every decoder has failed on this file before", unsupportedBy: [] };
  }
  if (!extended) return decodeWithLibRaw(file, request, id, bytes);
  const unsupportedBy: string[] = [];
  const failures: DecodeFailure[] = [];
  let skipped = false;
  for (const entry of chain) {
    const key = id === undefined ? undefined : answerKey(id, entry);
    if (request?.background && key !== undefined && unanswered.has(key)) {
      skipped = true;
      continue;
    }
    const decoded = isExtension(entry)
      ? await decodeWithExtension(entry, file, name, request, key)
      : await decodeWithLibRaw(file, request, id, bytes);
    const decoder = decoderMarkerId(entry);
    if (!("failure" in decoded)) {
      return {
        ...decoded,
        decoder,
        ...(unsupportedBy.length > 0 ? { unsupportedBy } : {}),
        ...(signature ? { signature } : {}),
      };
    }
    if (decoded.failure === "aborted" || abandoned(request)) return ABORTED;
    if (decoded.failure === "unsupported") unsupportedBy.push(decoder);
    failures.push(decoded);
  }
  // A decoder passed by for having given no answer may still answer later.
  const unsupported = !skipped && failures.every((f) => f.failure === "unsupported");
  const reason = failures.flatMap((f) => (f.reason ? [f.reason] : [])).join("; ");
  return {
    failure: unsupported ? "unsupported" : "transient",
    ...(reason ? { reason } : {}),
    ...(failures.some((f) => f.timedOut) ? { timedOut: true } : {}),
    ...(unsupported && failures.some((f) => f.tooLarge) ? { tooLarge: true } : {}),
    unsupportedBy,
  };
}

async function decodeWithLibRaw(
  file: Blob,
  request: DecodeRequest | undefined,
  id: string | undefined,
  bytes: ArrayBuffer | (() => Promise<ArrayBuffer>) | undefined,
): Promise<RawFloatImage | DecodeFailure> {
  let buffer: ArrayBuffer;
  try {
    buffer = typeof bytes === "function" ? await bytes() : (bytes ?? (await file.arrayBuffer()));
  } catch (e) {
    return { failure: "transient", reason: `couldn't read the file (${describeError(e)})` };
  }

  // Prefer libraw: it decodes every compression (incl. Nikon NEF), applies
  // camera WB and orientation, and outputs full-precision linear data. Only
  // the in-house fallback reads the buffer after it, and only a TIFF stream,
  // so libraw takes any other buffer read here without a copy.
  const transfer = !bytes && !isTiffStream(buffer);
  const viaLib = await decodeRawFloatViaLibRaw(buffer, request, transfer, () => file.arrayBuffer());
  if (!("failure" in viaLib)) {
    if (id !== undefined) unanswered.delete(id);
    return { ...viaLib, oriented: true };
  }
  if (viaLib.timedOut && id !== undefined) markUnanswered(id);
  if (abandoned(request)) return ABORTED;

  // In-house fallback handles only uncompressed CFA (sensor-native orientation).
  // A file it can't take either keeps libraw's verdict.
  if (transfer) return viaLib;
  try {
    const reader = new TiffReader(buffer);
    const info = findRawIfd(reader);
    if (!info || info.compression !== COMPRESSION.None) return viaLib;
    const plane = readSensorPlane(reader, info);
    if (!plane) return viaLib;
    const data = developRawPlaneFloat(plane.samples, plane.options);
    return { data, width: info.width, height: info.height, oriented: false };
  } catch (e) {
    return { ...viaLib, reason: `${viaLib.reason ?? "no decoder took the file"} (in-house decode: ${describeError(e)})` };
  }
}

type LinearImage = Extract<DecodedImageResult, { kind: "linear" }>;

const positive = (v: unknown): v is number => typeof v === "number" && v > 0 && Number.isFinite(v);

/** What an extension's decoder reported of the photo, as far as it is usable. */
function reportedOf(image: LinearImage): Pick<RawFloatImage, "asShotMultipliers" | "colorTemperature" | "rawExposureBias"> {
  const m = image.asShotMultipliers;
  const bias = image.rawExposureBias;
  return {
    ...(Array.isArray(m) && m.length === 3 && m.every(positive) ? { asShotMultipliers: [m[0], m[1], m[2]] } : {}),
    ...(positive(image.colorTemperature) ? { colorTemperature: image.colorTemperature } : {}),
    ...(typeof bias === "number" && Number.isFinite(bias) && bias !== 0 ? { rawExposureBias: bias } : {}),
  };
}

const frameSide = (v: unknown, decoded: number): number => (Number.isInteger(v) && positive(v) ? v : decoded);

/** The file by an extension's decoder: its frame finished as libraw's is, and
 *  what it reported of the photo. `key`: how its answers on the file are
 *  remembered (answerKey). A decoder that answers nothing, throws, or answers
 *  an image core can't use has found nothing usable in the file. */
async function decodeWithExtension(
  entry: ExtensionChainEntry,
  file: Blob,
  name: string,
  request: RawDecodeRequest | undefined,
  key: string | undefined,
): Promise<RawFloatImage | DecodeFailure> {
  const outcome = await runExtensionDecoder(entry, file, {
    name,
    ...(request?.targetEdge ? { targetEdge: request.targetEdge } : {}),
    // The cache entry's centre sample and a frame read at native resolution
    // need the whole frame.
    fullSize: !request?.targetEdge || request.cacheEdge !== undefined,
    ...(request?.asShotMultipliers ? { asShotMultipliers: request.asShotMultipliers } : {}),
    background: request?.background ?? false,
    ...(request?.signal ? { signal: request.signal } : {}),
  });
  if (!outcome.ok) {
    if (outcome.aborted) return ABORTED;
    if (!outcome.timedOut) return { failure: "unsupported", reason: outcome.reason };
    if (key !== undefined) markUnanswered(key);
    return { failure: "transient", reason: outcome.reason, timedOut: true };
  }
  if (key !== undefined) unanswered.delete(key);
  const { image } = outcome;
  if (image.kind !== "linear") return { failure: "unsupported", reason: `${entry.label} answered 8-bit pixels` };
  const turn = request?.turn ? normalizeRotation(request.turn) : 0;
  // A frame left as the sensor lay is turned upright here, as libraw's is.
  const uprights = image.oriented !== true && request?.orientation !== undefined;
  const upright = uprights ? orientationToRotation(request?.orientation) : 0;
  let built: BuiltFrame;
  try {
    built = await finishLinearFrame(
      {
        pixels: image.data,
        width: image.width,
        height: image.height,
        turn: normalizeRotation(upright + turn),
        cacheEdge: request?.cacheEdge,
      },
      { background: request?.background, signal: request?.signal },
    );
  } catch (e) {
    if (isAbandoned(e)) return ABORTED;
    return { failure: "transient", reason: `${entry.label}: the frame couldn't be finished (${describeError(e)})` };
  }
  const sourceWidth = frameSide(image.sourceWidth, image.width);
  const sourceHeight = frameSide(image.sourceHeight, image.height);
  const reduced = sourceWidth > image.width || sourceHeight > image.height;
  return {
    data: built.data,
    width: built.width,
    height: built.height,
    oriented: image.oriented === true || uprights,
    ...reportedOf(image),
    ...(reduced ? { halfSize: true, sourceWidth, sourceHeight } : {}),
    ...(turn ? { turned: turn } : {}),
    ...(built.entry ? { entry: built.entry } : {}),
  };
}

const describeError = (e: unknown): string =>
  e instanceof Error ? `${e.name}: ${e.message}` : String(e);

/** Whether `buffer` opens as TiffReader reads it: a byte-order mark, then 42. */
function isTiffStream(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 8) return false;
  const view = new DataView(buffer);
  const order = view.getUint16(0, false);
  if (order !== 0x4949 && order !== 0x4d4d) return false;
  return view.getUint16(2, order === 0x4949) === 42;
}

/** The in-house decode of uncompressed CFA data (sensor-native orientation),
 *  or null: for a file it can't take, and for one an extension's decoder leads
 *  for, which the float decode reads. `bytes`: the file's, read already by the
 *  caller, as decodeRawToFloat takes them. */
export async function decodeRawToBitmap(
  file: Blob,
  bytes?: ArrayBuffer,
): Promise<{ bitmap: ImageBitmap; oriented: boolean } | null> {
  const [head] = rawChain(file instanceof File ? file.name : "").entries;
  if (head && isExtension(head)) return null;
  let buffer: ArrayBuffer;
  try {
    buffer = bytes ?? (await file.arrayBuffer());
  } catch {
    return null;
  }

  try {
    const reader = new TiffReader(buffer);
    const info = findRawIfd(reader);
    if (info && info.compression === COMPRESSION.None) {
      const bitmap = await developUncompressed(reader, info);
      if (bitmap) return { bitmap, oriented: false };
    }
  } catch {
    // not a TIFF stream we understand
  }
  return null;
}

async function developUncompressed(
  reader: TiffReader,
  info: RawIfdInfo,
): Promise<ImageBitmap | null> {
  const plane = readSensorPlane(reader, info);
  if (!plane) return null;
  const rgba = developRawPlane(plane.samples, plane.options);
  return rgbaToBitmap(rgba, info.width, info.height);
}

interface SensorPlane {
  samples: Uint16Array;
  options: DevelopOptions;
}

// The raw IFD's samples in linear sensor units, with the levels and colour
// data that develop them. A DNG may store its samples through a
// LinearizationTable — the stored code indexes the table, and BlackLevel and
// WhiteLevel are given in the table's output units. The Leica M8 keeps 8-bit
// codes for a 14-bit sensor this way; scaling the codes themselves against
// WhiteLevel leaves every sample within 2% of black.
function readSensorPlane(reader: TiffReader, info: RawIfdInfo): SensorPlane | null {
  const { ifd, width, height, bitsPerSample } = info;
  if (width * height > MAX_DECODE_PIXELS) return null;
  const strips = readStrips(reader, ifd);
  // Short strips would unpack to a frame that is black past the data; the
  // embedded preview shows the photo better.
  if (!strips || strips.length < planeBytes(bitsPerSample, width, height)) return null;
  const samples = unpackPlane(strips, bitsPerSample, width, height, reader.le);
  if (samples.length < width * height) return null;

  const table = readLinearizationTable(reader, ifd);
  if (table) linearizeSamples(samples, table);
  // Without a WhiteLevel, white is the top of whatever space the samples are
  // in: the table's last entry, else the full code range.
  const defaultWhite = table ? table[table.length - 1] : (1 << bitsPerSample) - 1;
  const { black, white } = readLevels(reader, ifd, defaultWhite);
  return {
    samples,
    options: {
      width,
      height,
      black,
      white,
      cfa: readCFA(reader, ifd),
      wb: readWhiteBalance(reader),
    },
  };
}

function readLinearizationTable(reader: TiffReader, ifd: Ifd): number[] | undefined {
  const e = ifd.get(TIFF_TAG.LinearizationTable);
  if (!e) return undefined;
  const table = reader.values(e);
  return table.length ? table : undefined;
}

// Concatenate all strips of an IFD into one contiguous byte buffer.
function readStrips(reader: TiffReader, ifd: Ifd): Uint8Array | null {
  const offsetsEntry = ifd.get(TIFF_TAG.StripOffsets);
  const countsEntry = ifd.get(TIFF_TAG.StripByteCounts);
  if (!offsetsEntry || !countsEntry) return null;

  const offsets = reader.values(offsetsEntry);
  const counts = reader.values(countsEntry, offsets.length);
  if (counts.length < offsets.length) return null;
  const buf = reader.view.buffer;
  let total = 0;
  for (let i = 0; i < offsets.length; i++) {
    const start = reader.base + offsets[i];
    if (start < 0 || start + counts[i] > buf.byteLength) return null;
    total += counts[i];
  }
  if (total <= 0 || total > buf.byteLength) return null;

  const out = new Uint8Array(total);
  let pos = 0;
  for (let i = 0; i < offsets.length; i++) {
    out.set(new Uint8Array(buf, reader.base + offsets[i], counts[i]), pos);
    pos += counts[i];
  }
  return out;
}

function planeBytes(bits: number, width: number, height: number): number {
  return bits === 8 || bits === 16
    ? (width * height * bits) / 8
    : Math.ceil((width * bits) / 8) * height;
}

// Unpack the sensor plane. 8/16-bit samples read straight through; sub-byte
// widths are unpacked per row, since TIFF pads each row to a byte boundary.
function unpackPlane(
  strips: Uint8Array,
  bits: number,
  width: number,
  height: number,
  le: boolean,
): Uint16Array {
  if (bits === 8 || bits === 16) {
    return unpackSamples(strips, bits, width * height, le);
  }
  const out = new Uint16Array(width * height);
  const rowBytes = Math.ceil((width * bits) / 8);
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowBytes;
    if (rowStart >= strips.length) break;
    const row = strips.subarray(rowStart, rowStart + rowBytes);
    out.set(unpackSamples(row, bits, width, le), y * width);
  }
  return out;
}

function readCFA(
  reader: TiffReader,
  ifd: Ifd,
): [number, number, number, number] {
  const e = ifd.get(TIFF_TAG.CFAPattern);
  if (e) {
    const v = reader.values(e);
    if (v.length >= 4) return [v[0], v[1], v[2], v[3]];
  }
  return DEFAULT_CFA;
}

function readLevels(
  reader: TiffReader,
  ifd: Ifd,
  defaultWhite: number,
): { black: number; white: number } {
  let black = 0;
  const blackE = ifd.get(TIFF_TAG.BlackLevel);
  if (blackE) {
    const v = reader.values(blackE);
    if (v.length) black = v.reduce((a, b) => a + b, 0) / v.length;
  }
  let white = 0;
  const whiteE = ifd.get(TIFF_TAG.WhiteLevel);
  if (whiteE) white = reader.values(whiteE)[0] ?? 0;
  if (!white) white = defaultWhite;
  return { black, white };
}

// AsShotNeutral (DNG) gives the camera-neutral per channel; the WB gain is its
// reciprocal. Searches all IFDs since it usually sits in IFD0, not the raw one.
function readWhiteBalance(reader: TiffReader): [number, number, number] {
  for (const ifd of reader.ifds) {
    const e = ifd.get(TIFF_TAG.AsShotNeutral);
    if (!e) continue;
    const v = reader.values(e);
    if (v.length >= 3 && v[0] && v[1] && v[2]) {
      return [1 / v[0], 1 / v[1], 1 / v[2]];
    }
  }
  return [1, 1, 1];
}

async function rgbaToBitmap(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<ImageBitmap> {
  // Allocate an ArrayBuffer-backed ImageData and copy in, so any source buffer
  // type is accepted.
  const image = new ImageData(width, height);
  image.data.set(rgba.subarray(0, image.data.length));
  return createImageBitmap(image);
}
