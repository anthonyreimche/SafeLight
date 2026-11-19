// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The main thread's side of heif.worker.ts: HEIF decodes, and the conversion
// of an extension decoder's pixels to the same frame or thumbnail, go to at
// most two dedicated workers, each holding its own libheif. An opened photo's
// work goes ahead of background work, which never takes the last worker. A
// worker that doesn't answer in time is ended and its job fails; workers that
// keep failing to start are given up on, and every later job fails at once
// rather than decoding on the main thread. With no Worker at all (vitest's
// node) the job runs inline. Workers left idle are ended, as each keeps the
// heap of the largest image it decoded.

import { decodeTimeLimit } from "@/catalog/image-decoders";
import {
  answerHeifRequest,
  type HeifReply,
  type HeifRequest,
  type PixelImage,
  type ThumbImage,
} from "./heif-decode";
import type { HalfFrame } from "./profile-frame";

const POOL_SIZE = 2;
const BACKGROUND_LIMIT = POOL_SIZE - 1;
/** With no job queued or running for this long, the workers are ended. */
export const IDLE_MS = 30_000;
// A bundle that fails to load must not respawn forever; one bad file must
// not end HEIF decoding for the session.
const MAX_CONSECUTIVE_FAILURES = 3;

export type HeifBridgeFailure = { ok: false; reason: string; aborted?: boolean };

export type HeifFrameResult =
  | { ok: true; frame: HalfFrame; sourceWidth: number; sourceHeight: number; hdr: boolean }
  | HeifBridgeFailure;

export type HeifThumbResult =
  | { ok: true; bitmap: ImageBitmap; width: number; height: number; sourceWidth: number; sourceHeight: number }
  | HeifBridgeFailure;

export type LinearFrameResult = { ok: true; frame: HalfFrame } | HeifBridgeFailure;

export type PixelsThumbResult = { ok: true; bitmap: ImageBitmap; width: number; height: number } | HeifBridgeFailure;

interface Priority {
  background: boolean;
  signal?: AbortSignal;
}

interface Task {
  request: HeifRequest;
  transfer: Transferable[];
  background: boolean;
  timeoutMs: number;
  settle: (reply: HeifReply | Error) => void;
}

interface Slot {
  worker: Worker;
  task: Task | null;
  timer: ReturnType<typeof setTimeout> | null;
}

const slots: Slot[] = [];
const waiting: { interactive: Task[]; background: Task[] } = { interactive: [], background: [] };
let broken = false;
let failures = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let nextId = 1;

const ABORTED: HeifBridgeFailure = { ok: false, reason: "the decode was abandoned", aborted: true };
const UNAVAILABLE = "the HEIF decoder could not be started";

function armIdleTimer(): void {
  clearTimeout(idleTimer);
  idleTimer = undefined;
  if (slots.length === 0 || slots.some((s) => s.task) || waiting.interactive.length || waiting.background.length) return;
  idleTimer = setTimeout(() => {
    idleTimer = undefined;
    for (const slot of slots.splice(0)) slot.worker.terminate();
  }, IDLE_MS);
}

function noteFailure(): void {
  if (++failures < MAX_CONSECUTIVE_FAILURES) return;
  broken = true;
  const queued = [...waiting.interactive, ...waiting.background];
  waiting.interactive = [];
  waiting.background = [];
  for (const task of queued) task.settle(new Error(UNAVAILABLE));
}

function retire(slot: Slot): void {
  const at = slots.indexOf(slot);
  if (at >= 0) slots.splice(at, 1);
  clearTimeout(slot.timer ?? undefined);
  slot.timer = null;
  slot.worker.terminate();
}

/** `counts`: whether the failure says the workers can't run at all, which a
 *  file that hangs one doesn't. */
function fail(slot: Slot, reason: string, counts = true): void {
  if (!slots.includes(slot)) return;
  const task = slot.task;
  slot.task = null;
  retire(slot);
  if (counts) noteFailure();
  task?.settle(new Error(reason));
  pump();
}

function spawn(): Slot | null {
  try {
    const worker = new Worker(new URL("./heif.worker.ts", import.meta.url), { type: "module" });
    const slot: Slot = { worker, task: null, timer: null };
    worker.onmessage = (e: MessageEvent<HeifReply>) => {
      const task = slot.task;
      if (!task || e.data.id !== task.request.id) return;
      clearTimeout(slot.timer ?? undefined);
      slot.timer = null;
      slot.task = null;
      failures = 0;
      if (e.data.op === "error" && e.data.fatal) retire(slot);
      task.settle(e.data);
      pump();
    };
    worker.onerror = (e) => {
      e.preventDefault();
      fail(slot, `the HEIF decoder failed: ${e.message || "no message"}`);
    };
    slots.push(slot);
    return slot;
  } catch {
    noteFailure();
    return null;
  }
}

function dispatch(slot: Slot, task: Task): void {
  slot.task = task;
  try {
    slot.worker.postMessage(task.request, task.transfer);
  } catch (e) {
    slot.task = null;
    task.settle(new Error(`the job could not be sent to the HEIF decoder: ${e instanceof Error ? e.message : String(e)}`));
    return;
  }
  slot.timer = setTimeout(() => fail(slot, "the HEIF decoder gave no answer", false), task.timeoutMs);
}

const backgroundBusy = (): number => slots.filter((s) => s.task?.background).length;

function next(): Task | undefined {
  const interactive = waiting.interactive.shift();
  if (interactive) return interactive;
  return backgroundBusy() < BACKGROUND_LIMIT ? waiting.background.shift() : undefined;
}

function pump(): void {
  clearTimeout(idleTimer);
  idleTimer = undefined;
  while (!broken && (waiting.interactive.length > 0 || waiting.background.length > 0)) {
    const slot = slots.find((s) => !s.task) ?? (slots.length < POOL_SIZE ? spawn() : null);
    if (!slot) {
      if (slots.length === 0) continue;
      break;
    }
    const task = next();
    if (!task) break;
    dispatch(slot, task);
  }
  armIdleTimer();
}

async function runInline(task: Task): Promise<void> {
  const { reply } = await answerHeifRequest(async () => (await import("./heif-lib")).heifLib(), task.request);
  if (reply.op === "error" && reply.fatal) (await import("./heif-lib")).resetHeifLib();
  task.settle(reply);
}

function closeReplyImage(reply: HeifReply): void {
  if ((reply.op === "thumb" || reply.op === "pixels-thumb") && reply.image.kind === "bitmap") reply.image.bitmap.close();
}

/** The job's reply, or why there is none. A job whose signal fires answers
 *  aborted at once: dropped unsent while it waits, its reply ignored once a
 *  worker has it. */
function submit(
  make: (id: number) => HeifRequest,
  transfer: Transferable[],
  priority: Priority,
  timeoutMs: number,
): Promise<HeifReply | HeifBridgeFailure> {
  const { background, signal } = priority;
  if (signal?.aborted) return Promise.resolve(ABORTED);
  const request = make(nextId++);
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: HeifReply | HeifBridgeFailure) => {
      if (done) {
        if (!("ok" in value)) closeReplyImage(value);
        return;
      }
      done = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const task: Task = {
      request,
      transfer,
      background,
      timeoutMs,
      settle: (reply) => finish(reply instanceof Error ? { ok: false, reason: reply.message } : reply),
    };
    function onAbort() {
      for (const queue of [waiting.interactive, waiting.background]) {
        const at = queue.indexOf(task);
        if (at >= 0) queue.splice(at, 1);
      }
      finish(ABORTED);
      armIdleTimer();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    if (typeof Worker === "undefined") {
      void runInline(task);
      return;
    }
    if (broken) {
      task.settle(new Error(UNAVAILABLE));
      return;
    }
    (background ? waiting.background : waiting.interactive).push(task);
    pump();
  });
}


function unexpected(reply: HeifReply): HeifBridgeFailure {
  return { ok: false, reason: reply.op === "error" ? reply.message : "the HEIF decoder answered another request" };
}

async function bitmapOf(image: ThumbImage, width: number, height: number): Promise<ImageBitmap | null> {
  if (image.kind === "bitmap") return image.bitmap;
  if (typeof createImageBitmap !== "function" || typeof ImageData !== "function") return null;
  return createImageBitmap(new ImageData(image.data, width, height));
}

const NO_BITMAP: HeifBridgeFailure = { ok: false, reason: "no ImageBitmap can be made on this thread" };

/** The primary image of the HEIF `file` as a linear Rec.709 frame (half
 *  floats, display-referred, unclipped), averaged down to `targetEdge` and
 *  turned clockwise by `turn` after libheif has turned it upright. */
export async function decodeHeifFrame(
  file: Blob,
  opts: { targetEdge?: number; turn?: number; background: boolean; signal?: AbortSignal },
): Promise<HeifFrameResult> {
  const reply = await submit(
    (id) => ({ id, op: "frame", file, targetEdge: opts.targetEdge, turn: opts.turn ?? 0 }),
    [],
    opts,
    decodeTimeLimit(file.size),
  );
  if ("ok" in reply) return reply;
  if (reply.op !== "frame") return unexpected(reply);
  const { frame, sourceWidth, sourceHeight, hdr } = reply;
  return { ok: true, frame, sourceWidth, sourceHeight, hdr };
}

/** The primary image of the HEIF `file` as an upright sRGB thumbnail no
 *  longer than `maxEdge`, with the upright image's full size. */
export async function decodeHeifThumb(
  file: Blob,
  opts: { maxEdge: number; background: boolean; signal?: AbortSignal },
): Promise<HeifThumbResult> {
  const reply = await submit(
    (id) => ({ id, op: "thumb", file, maxEdge: opts.maxEdge }),
    [],
    opts,
    decodeTimeLimit(file.size),
  );
  if ("ok" in reply) return reply;
  if (reply.op !== "thumb") return unexpected(reply);
  const { width, height, sourceWidth, sourceHeight } = reply;
  const bitmap = await bitmapOf(reply.image, width, height);
  return bitmap ? { ok: true, bitmap, width, height, sourceWidth, sourceHeight } : NO_BITMAP;
}

const ownBuffer = (data: Float32Array): Float32Array<ArrayBuffer> =>
  data.buffer instanceof ArrayBuffer && data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
    ? new Float32Array(data.buffer)
    : data.slice();

/** An extension decoder's linear Rec.709 RGBA (`width` × `height`) as the
 *  frame a HEIF decode gives. `data` is handed to the worker when it owns its
 *  whole ArrayBuffer, otherwise copied once. */
export async function convertLinearFrame(
  data: Float32Array,
  width: number,
  height: number,
  opts: { targetEdge?: number; turn?: number; background: boolean; signal?: AbortSignal },
): Promise<LinearFrameResult> {
  const owned = ownBuffer(data);
  const reply = await submit(
    (id) => ({ id, op: "linear-frame", data: owned, width, height, targetEdge: opts.targetEdge, turn: opts.turn ?? 0 }),
    [owned.buffer],
    opts,
    decodeTimeLimit(owned.byteLength),
  );
  if ("ok" in reply) return reply;
  if (reply.op !== "linear-frame") return unexpected(reply);
  return { ok: true, frame: reply.frame };
}

/** An extension decoder's pixels as an sRGB thumbnail no longer than
 *  `maxEdge`. Pixels on a whole ArrayBuffer of their own are handed to the
 *  worker, so the caller must not use them after; others are copied. */
export async function convertPixelsThumb(
  image: PixelImage,
  opts: { maxEdge: number; background: boolean; signal?: AbortSignal },
): Promise<PixelsThumbResult> {
  const buffer: ArrayBuffer | SharedArrayBuffer = image.data.buffer;
  const handed = buffer instanceof ArrayBuffer && image.data.byteOffset === 0 && image.data.byteLength === buffer.byteLength;
  const reply = await submit(
    (id) => ({ id, op: "pixels-thumb", image, maxEdge: opts.maxEdge }),
    handed ? [buffer] : [],
    opts,
    decodeTimeLimit(image.data.byteLength),
  );
  if ("ok" in reply) return reply;
  if (reply.op !== "pixels-thumb") return unexpected(reply);
  const bitmap = await bitmapOf(reply.image, reply.width, reply.height);
  return bitmap ? { ok: true, bitmap, width: reply.width, height: reply.height } : NO_BITMAP;
}
