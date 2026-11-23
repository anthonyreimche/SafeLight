// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Which decoders read each photo format, and in what order. Core has one
// decoder per format, run by its own load paths (load-image.ts, decode.ts,
// import-decode.ts); extensions add more through api.library.registerDecoder,
// and the person orders them in Preferences ▸ File formats. Each load path
// walks decoderChain(format) and moves on when a decoder answers nothing.
//
// Decodes core keeps across launches (the RAW cache, GPU sources) are keyed by
// chainSignature, which stays "" while core's decoder leads, so the default
// chain keeps every existing key. A decoder that checks files first
// (ImageDecoderContribution.accepts) and declines one is left out of that
// file's chain (answeringChain), so its keys stay as they would be without it.

import { useSyncExternalStore } from "react";
import photoTypes from "../../electron/photo-types.json";
import type {
  DecodedImageResult,
  ImageDecodeRequest,
  ImageDecoderContribution,
  ImageDecoderInfo,
} from "@/extensions/api/library";
import { getExtension } from "@/raw/raw-preview";
import { MAX_DECODE_PIXELS } from "@/raw/decode-limits";
import { getSettings, useSettings } from "@/state/settings-store";

export type CoreDecoderId = "browser" | "tiff" | "netpbm" | "heif" | "libraw";

export interface DecoderFormat {
  id: string;
  label: string;
  extensions: readonly string[];
  raw: boolean;
  core: CoreDecoderId;
}

const STANDARD_FORMATS: readonly DecoderFormat[] = [
  { id: "jpeg", label: "JPEG", extensions: [".jpg", ".jpeg"], raw: false, core: "browser" },
  { id: "png", label: "PNG", extensions: [".png"], raw: false, core: "browser" },
  { id: "webp", label: "WebP", extensions: [".webp"], raw: false, core: "browser" },
  { id: "avif", label: "AVIF", extensions: [".avif"], raw: false, core: "browser" },
  { id: "tiff", label: "TIFF", extensions: [".tif", ".tiff"], raw: false, core: "tiff" },
  { id: "netpbm", label: "NetPBM", extensions: [".ppm", ".pgm", ".pbm", ".pnm"], raw: false, core: "netpbm" },
  { id: "heif", label: "HEIC / HEIF", extensions: [".heic", ".heif", ".hif"], raw: false, core: "heif" },
];

const RAW_FORMATS: readonly DecoderFormat[] = Object.keys(photoTypes.raw).map((ext) => ({
  id: ext.slice(1),
  label: ext.slice(1).toUpperCase(),
  extensions: [ext],
  raw: true,
  core: "libraw",
}));

/** Every format a decoder can be ordered for: the standard ones, then one per
 *  RAW extension. */
export const DECODER_FORMATS: readonly DecoderFormat[] = [...STANDARD_FORMATS, ...RAW_FORMATS];

const FORMAT_BY_EXTENSION = new Map(
  DECODER_FORMATS.flatMap((format) => format.extensions.map((ext) => [ext, format] as const)),
);
const FORMAT_BY_ID = new Map(DECODER_FORMATS.map((format) => [format.id, format]));

/** The format of the file named `name`, by its extension, or null. */
export function formatOf(name: string): DecoderFormat | null {
  return FORMAT_BY_EXTENSION.get(getExtension(name)) ?? null;
}

export interface CoreChainEntry {
  id: CoreDecoderId;
  owner: "core";
  label: string;
}

export interface ExtensionChainEntry {
  /** "<extension id>/<decoder id>". */
  id: string;
  owner: string;
  label: string;
  version: string;
  formats: readonly string[];
  decoder: ImageDecoderContribution;
}

export type ChainEntry = CoreChainEntry | ExtensionChainEntry;

export function isExtensionEntry(entry: ChainEntry): entry is ExtensionChainEntry {
  return "decoder" in entry;
}

const CORE_LABEL = "Built-in";

/** For a non-RAW file taken by its MIME type alone, its name saying no format. */
export const UNNAMED_FORMAT_DECODER: CoreChainEntry = { id: "browser", owner: "core", label: CORE_LABEL };

const registered = new Map<string, ExtensionChainEntry>();
const listeners = new Set<() => void>();
let listed: readonly ImageDecoderInfo[] = [];

function coreEntry(format: DecoderFormat): CoreChainEntry {
  return { id: format.core, owner: "core", label: CORE_LABEL };
}

function savedOrder(formatId: string): string[] {
  const order: unknown = getSettings().decoderOrder?.[formatId];
  return Array.isArray(order) ? order.filter((id): id is string => typeof id === "string") : [];
}

/** The decoders that read format `formatId`, in the order to try them: the
 *  person's saved order, then those it leaves out (core's first, then
 *  extensions' as they registered). Decoders that aren't registered now are
 *  left out. */
export function decoderChain(formatId: string): readonly ChainEntry[] {
  const format = FORMAT_BY_ID.get(formatId);
  if (!format) return [];
  const available: ChainEntry[] = [
    coreEntry(format),
    ...[...registered.values()].filter((entry) => entry.formats.includes(formatId)),
  ];
  const byId = new Map(available.map((entry) => [entry.id, entry]));
  const chain: ChainEntry[] = [];
  for (const id of savedOrder(formatId)) {
    const entry = byId.get(id);
    if (!entry) continue;
    chain.push(entry);
    byId.delete(id);
  }
  return [...chain, ...byId.values()];
}

/** What the chain for `formatId` decodes with, for keys of decodes kept
 *  across launches: "" while core's decoder leads, else each decoder tried
 *  before core's with its version, then core's. */
export function chainSignature(formatId: string): string {
  return signatureOf(decoderChain(formatId));
}

/** What `chain` decodes with, as chainSignature says it. */
export function signatureOf(chain: readonly ChainEntry[]): string {
  const coreAt = chain.findIndex((entry) => entry.owner === "core");
  if (coreAt <= 0) return "";
  return chain
    .slice(0, coreAt + 1)
    .map((entry) => (isExtensionEntry(entry) ? `${entry.id}@${entry.version}` : entry.id))
    .join(">");
}

// ─── Decoders that check a file first ────────────────────────────────────────

// What each decoder with `accepts` answered, by decoder version and file (its
// name and size), for the session; the RAW cache keeps a photo's too
// (photo-cache-key.ts). Only the latest are kept.
const VERDICT_LIMIT = 20_000;
// A check is meant to read a header: one slower than this is taken as a yes.
const ACCEPTS_TIME_LIMIT_MS = 5_000;
const verdicts = new Map<string, boolean>();
const asking = new Map<string, Promise<boolean>>();

const verdictKey = (entry: ExtensionChainEntry, name: string, size: number): string =>
  `${entry.id}@${entry.version}|${name}:${size}`;

/** Whether `entry` reads the file `name` of `size` bytes: true for a decoder
 *  that doesn't check files first, undefined for one not asked yet. */
export function acceptsVerdict(entry: ChainEntry, name: string, size: number): boolean | undefined {
  if (!isExtensionEntry(entry) || !entry.decoder.accepts) return true;
  return verdicts.get(verdictKey(entry, name, size));
}

/** Keep what `entry` answered about the file `name` of `size` bytes. */
export function rememberAccepts(entry: ExtensionChainEntry, name: string, size: number, accepts: boolean): void {
  const key = verdictKey(entry, name, size);
  verdicts.delete(key);
  verdicts.set(key, accepts);
  if (verdicts.size <= VERDICT_LIMIT) return;
  const oldest = verdicts.keys().next().value;
  if (oldest !== undefined) verdicts.delete(oldest);
}

/** Whether `entry` reads `file` (named `name`): its remembered answer, or its
 *  `accepts` asked now, outside its decode queue. A check that throws, or
 *  answers late or with no boolean, counts as a yes and isn't remembered: the
 *  decode then decides. */
export function askAccepts(entry: ChainEntry, file: Blob, name: string): Promise<boolean> {
  const known = acceptsVerdict(entry, name, file.size);
  if (known !== undefined || !isExtensionEntry(entry)) return Promise.resolve(known ?? true);
  const key = verdictKey(entry, name, file.size);
  const pending = asking.get(key) ?? ask(entry, file, name).finally(() => asking.delete(key));
  asking.set(key, pending);
  return pending;
}

async function ask(entry: ExtensionChainEntry, file: Blob, name: string): Promise<boolean> {
  const { accepts } = entry.decoder;
  if (!accepts) return true;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("late");
    }, ACCEPTS_TIME_LIMIT_MS);
  });
  try {
    const checked = Promise.resolve().then(() => accepts.call(entry.decoder, file, { name, signal: controller.signal }));
    const answer: unknown = await Promise.race([checked, late]);
    if (typeof answer !== "boolean") {
      if (answer !== "late") warn(entry.owner, `decoder "${entry.id}": accepts answered ${String(answer)}, not a boolean`);
      return true;
    }
    rememberAccepts(entry, name, file.size, answer);
    return answer;
  } catch (e) {
    warn(entry.owner, `decoder "${entry.id}" couldn't check ${name}: ${e instanceof Error ? e.message : String(e)}`);
    return true;
  } finally {
    clearTimeout(timer);
  }
}

/** The decoders that read the file `name` of `size` bytes, of format
 *  `formatId`, in order: its chain without those known to decline it. */
export function answeringChain(formatId: string, name: string, size: number): readonly ChainEntry[] {
  return decoderChain(formatId).filter((entry) => acceptsVerdict(entry, name, size) !== false);
}

/** The extensions whose decoders the person put ahead of every decoder now
 *  registered for `formatId`: a photo of that format decodes differently once
 *  they register. A saved id is "<extension id>/<decoder id>". */
export function missingLeadOwners(formatId: string): string[] {
  const format = FORMAT_BY_ID.get(formatId);
  if (!format) return [];
  const owners: string[] = [];
  for (const id of savedOrder(formatId)) {
    if (id === format.core || registered.has(id)) break;
    const slash = id.indexOf("/");
    if (slash > 0) owners.push(id.slice(0, slash));
  }
  return owners;
}

/** `ids`, a new order of the decoders in `formatId`'s chain now, with the
 *  saved ones that aren't registered now kept at their places, so an
 *  extension turned off keeps its place for when it is back. */
export function keepingAbsent(formatId: string, ids: readonly string[]): string[] {
  const present = new Set(ids);
  const order = [...ids];
  savedOrder(formatId).forEach((id, index) => {
    if (!present.has(id)) order.splice(Math.min(index, order.length), 0, id);
  });
  return order;
}

/** `order` with format `formatId` set to `ids`, or taken out with null. */
export function withDecoderOrder(
  order: Readonly<Record<string, string[]>>,
  formatId: string,
  ids: readonly string[] | null,
): Record<string, string[]> {
  const { [formatId]: _replaced, ...rest } = order;
  return ids ? { ...rest, [formatId]: [...ids] } : rest;
}

function relist(): void {
  const core: ImageDecoderInfo[] = (["browser", "tiff", "netpbm", "heif", "libraw"] as const).map((id) => ({
    id,
    label: CORE_LABEL,
    owner: "core",
    formats: DECODER_FORMATS.filter((format) => format.core === id).map((format) => format.id),
  }));
  const extensions = [...registered.values()].map(({ id, label, owner, formats }) => ({ id, label, owner, formats }));
  listed = [...core, ...extensions];
}

function changed(): void {
  relist();
  for (const listener of listeners) listener();
}

relist();

let stopHearingSettings: (() => void) | null = null;

/** Every decoder, core's then extensions', with the formats each reads. The
 *  same array until the set changes. */
export function decoderList(): readonly ImageDecoderInfo[] {
  return listed;
}

/** Calls `listener` when a decoder comes or goes or the order changes;
 *  returns the unsubscribe. */
export function onDecodersChanged(listener: () => void): () => void {
  listeners.add(listener);
  stopHearingSettings ??= useSettings.subscribe((state, previous) => {
    if (state.decoderOrder !== previous.decoderOrder) changed();
  });
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0 || !stopHearingSettings) return;
    stopHearingSettings();
    stopHearingSettings = null;
  };
}

/** React hook: decoderList(), re-rendering as it changes. */
export function useDecoders(): readonly ImageDecoderInfo[] {
  return useSyncExternalStore(onDecodersChanged, decoderList);
}

function warn(extensionId: string, message: string): void {
  console.warn(`[extensions] ${extensionId}: ${message}`);
}

/** Hold `contribution` for `extensionId`, for the formats among its
 *  extensions that core knows. An id another extension holds can't clash, as
 *  ids are kept per extension; an extension may replace its own. */
export function registerImageDecoder(extensionId: string, contribution: ImageDecoderContribution): void {
  const c = contribution as Partial<ImageDecoderContribution> | null;
  if (typeof c !== "object" || c === null || typeof c.id !== "string" || c.id.length === 0) {
    warn(extensionId, "a decoder needs an id; registerDecoder ignored");
    return;
  }
  if (typeof c.label !== "string" || c.label.length === 0 || typeof c.decode !== "function") {
    warn(extensionId, `decoder "${c.id}" needs a label and a decode function; registerDecoder ignored`);
    return;
  }
  const formats = new Set<string>();
  for (const ext of Array.isArray(c.extensions) ? c.extensions : []) {
    const format = typeof ext === "string" ? FORMAT_BY_EXTENSION.get(ext.toLowerCase()) : undefined;
    if (format) formats.add(format.id);
    else warn(extensionId, `decoder "${c.id}": ${String(ext)} isn't a format Safelight imports; left out`);
  }
  if (formats.size === 0) {
    warn(extensionId, `decoder "${c.id}" reads no format Safelight imports; registerDecoder ignored`);
    return;
  }
  const id = `${extensionId}/${c.id}`;
  registered.set(id, {
    id,
    owner: extensionId,
    label: c.label,
    version: typeof c.version === "string" && c.version.length > 0 ? c.version : "1",
    formats: [...formats],
    decoder: contribution,
  });
  changed();
}

/** Drop decoder `id` that `extensionId` registered. */
export function unregisterImageDecoder(extensionId: string, id: string): void {
  if (registered.delete(`${extensionId}/${id}`)) changed();
}

/** Drop every decoder `extensionId` registered, as when it stops. */
export function dropImageDecoders(extensionId: string): void {
  let dropped = false;
  for (const [id, entry] of registered) {
    if (entry.owner !== extensionId) continue;
    registered.delete(id);
    dropped = true;
  }
  if (dropped) changed();
}

/** A decoder's image on a buffer core holds alone. */
export type OwnedDecodedImage =
  | (Extract<DecodedImageResult, { kind: "rgba8" }> & { data: Uint8ClampedArray<ArrayBuffer> })
  | (Extract<DecodedImageResult, { kind: "linear" }> & { data: Float32Array<ArrayBuffer> });

/** A decoder's failed answer. `declined`: its `accepts` passed the file on, so
 *  it never ran. `transient`: it failed in a way that may pass (it threw an
 *  error marked `transient`, or ran out of memory), so the file isn't to be
 *  remembered as one it can't read. */
export type ExtensionDecodeOutcome =
  | { ok: true; image: OwnedDecodedImage }
  | { ok: false; reason: string; aborted?: boolean; timedOut?: boolean; declined?: boolean; transient?: boolean };

/** Whether a decoder's throw is a failure that may pass. */
function isTransient(e: unknown): boolean {
  if (e instanceof RangeError) return true;
  return typeof e === "object" && e !== null && "transient" in e && e.transient === true;
}

export interface ExtensionDecodeRequest {
  name: string;
  targetEdge?: number;
  fullSize: boolean;
  asShotMultipliers?: readonly [number, number, number];
  background: boolean;
  signal?: AbortSignal;
}

const BASE_TIME_LIMIT_MS = 60_000;
const TIME_PER_MB_MS = 2_000;

/** How long a decode of `bytes` may run before it is abandoned. */
export function decodeTimeLimit(bytes: number): number {
  return BASE_TIME_LIMIT_MS + TIME_PER_MB_MS * Math.ceil(bytes / (1 << 20));
}

interface Task {
  entry: ExtensionChainEntry;
  file: Blob;
  request: ExtensionDecodeRequest;
  settle: (outcome: ExtensionDecodeOutcome) => void;
}

interface Lane {
  running: boolean;
  interactive: Task[];
  background: Task[];
}

const lanes = new Map<string, Lane>();

const ABORTED: ExtensionDecodeOutcome = { ok: false, reason: "The decode was no longer needed.", aborted: true };

/** Why `image` can't stand for a photo of `format`, or null. */
function problem(image: DecodedImageResult | null, format: DecoderFormat, request: ExtensionDecodeRequest): string | null {
  if (typeof image !== "object" || image === null) return "answered no image";
  const { width, height } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0)
    return `answered a size of ${width}×${height}`;
  if (width * height > MAX_DECODE_PIXELS) return `answered ${width}×${height}, more pixels than Safelight decodes`;
  if (image.kind === "rgba8") {
    if (format.raw) return "answered 8-bit pixels for a RAW photo, which needs linear ones";
    const data: unknown = image.data;
    if (!(data instanceof Uint8ClampedArray) && !(data instanceof Uint8Array))
      return "answered 8-bit pixels that aren't in a Uint8ClampedArray";
  } else if (image.kind === "linear") {
    if (!(image.data instanceof Float32Array)) return "answered linear pixels that aren't in a Float32Array";
    const fullWidth = image.sourceWidth ?? width;
    const fullHeight = image.sourceHeight ?? height;
    if (format.raw && request.fullSize && (fullWidth > width || fullHeight > height))
      return "answered a reduced decode where the full size is needed";
  } else {
    const kind: unknown = Reflect.get(image, "kind");
    return `answered an image of unknown kind "${String(kind)}"`;
  }
  if (image.data.length !== width * height * 4)
    return `answered ${image.data.length} values where ${width}×${height} RGBA takes ${width * height * 4}`;
  if (format.id === "heif" && image.oriented !== true)
    return "answered a HEIF image that isn't turned upright by its own rotation";
  return null;
}

/** `image` holding a buffer of its own: a view into a larger buffer, or into
 *  shared or wasm memory, is copied once. */
function owned(image: DecodedImageResult): OwnedDecodedImage {
  const { data } = image;
  const buffer: ArrayBuffer | SharedArrayBuffer = data.buffer;
  const whole = data.byteOffset === 0 && data.byteLength === buffer.byteLength ? buffer : null;
  const own = whole instanceof ArrayBuffer ? whole : null;
  if (image.kind === "rgba8") return { ...image, data: own ? new Uint8ClampedArray(own) : new Uint8ClampedArray(data) };
  return { ...image, data: own ? new Float32Array(own) : new Float32Array(image.data) };
}

function next(laneId: string): void {
  const lane = lanes.get(laneId);
  if (!lane || lane.running) return;
  const task = lane.interactive.shift() ?? lane.background.shift();
  if (!task) {
    lanes.delete(laneId);
    return;
  }
  lane.running = true;
  void dispatch(task).finally(() => {
    lane.running = false;
    next(laneId);
  });
}

async function dispatch(task: Task): Promise<void> {
  const { entry, file, request, settle } = task;
  if (request.signal?.aborted) {
    settle(ABORTED);
    return;
  }
  const format = FORMAT_BY_EXTENSION.get(getExtension(request.name));
  if (!format) {
    settle({ ok: false, reason: `${request.name} isn't a format Safelight imports.` });
    return;
  }
  const controller = new AbortController();
  let callerAborted: (outcome: ExtensionDecodeOutcome) => void = () => {};
  const callerGaveUp = new Promise<ExtensionDecodeOutcome>((resolve) => (callerAborted = resolve));
  const onCallerAbort = () => {
    controller.abort();
    callerAborted(ABORTED);
  };
  request.signal?.addEventListener("abort", onCallerAbort, { once: true });
  const limit = decodeTimeLimit(file.size);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<ExtensionDecodeOutcome>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, reason: `${entry.label} ran out of time.`, timedOut: true });
    }, limit);
  });
  const decodeRequest: ImageDecodeRequest = {
    name: request.name,
    ...(request.targetEdge !== undefined ? { targetEdge: request.targetEdge } : {}),
    fullSize: request.fullSize,
    ...(request.asShotMultipliers ? { asShotMultipliers: request.asShotMultipliers } : {}),
    background: request.background,
    signal: controller.signal,
  };
  const decoded = (async (): Promise<ExtensionDecodeOutcome> => {
    try {
      const image = await entry.decoder.decode(file, decodeRequest);
      if (image === null) return { ok: false, reason: `${entry.label} couldn't read this file.` };
      const bad = problem(image, format, request);
      if (bad) {
        warn(entry.owner, `decoder "${entry.id}" ${bad}`);
        return { ok: false, reason: `${entry.label} ${bad}.` };
      }
      return { ok: true, image: owned(image) };
    } catch (e) {
      const reason = `${entry.label} failed: ${e instanceof Error ? e.message : String(e)}`;
      return isTransient(e) ? { ok: false, reason, transient: true } : { ok: false, reason };
    }
  })();
  try {
    settle(await Promise.race([decoded, timedOut, callerGaveUp]));
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onCallerAbort);
  }
}

/** Decode `file` with extension decoder `entry`, one decode at a time per
 *  decoder, interactive requests ahead of background ones; a file the
 *  decoder's `accepts` declines is answered at once, never queued. Never
 *  rejects: a decoder that answers nothing, throws, answers an image core
 *  can't use or runs past its time limit (60 s and 2 s a megabyte, counted
 *  from when it starts) gives a reason instead. A decode past its limit, or
 *  one its caller gave up on, is abandoned with its signal aborted, and the
 *  next starts. */
export async function runExtensionDecoder(
  entry: ExtensionChainEntry,
  file: Blob,
  request: ExtensionDecodeRequest,
): Promise<ExtensionDecodeOutcome> {
  if (request.signal?.aborted) return ABORTED;
  if (!(await askAccepts(entry, file, request.name))) {
    return { ok: false, reason: `${entry.label} leaves this file to the next decoder.`, declined: true };
  }
  return queued(entry, file, request);
}

function queued(entry: ExtensionChainEntry, file: Blob, request: ExtensionDecodeRequest): Promise<ExtensionDecodeOutcome> {
  const { signal } = request;
  if (signal?.aborted) return Promise.resolve(ABORTED);
  return new Promise((resolve) => {
    // The caller giving up answers it at once, queued or running.
    const onAbort = () => settle(ABORTED);
    let settled = false;
    const settle = (outcome: ExtensionDecodeOutcome) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const lane = lanes.get(entry.id) ?? { running: false, interactive: [], background: [] };
    lanes.set(entry.id, lane);
    (request.background ? lane.background : lane.interactive).push({ entry, file, request, settle });
    next(entry.id);
  });
}
