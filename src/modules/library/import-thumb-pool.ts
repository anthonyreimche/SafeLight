// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Pool of import workers running the pixel stage (import-thumb-task) off the
// main thread, so a folder import scales across cores instead of queueing
// decode/rotate/encode work behind React. Workers spawn lazily on first use
// and stay for the session (imports recur: open, re-import, repair).
//
// Degradation, not failure: with no Worker support the task runs inline, and
// any worker-level error or stall resolves as { ok: false } — the caller's
// inline decode chain takes over, so a broken worker bundle can slow imports
// but never lose photos.

import {
  runThumbTask,
  type ThumbTaskInput,
  type ThumbTaskResult,
} from "./import-thumb-task";

interface WorkerSlot {
  worker: Worker;
  busy: boolean;
  currentResolve: ((r: ThumbTaskResult) => void) | null;
  timer: ReturnType<typeof setTimeout> | null;
}

// A thumbnail comes from the head of the file, so even a large RAW answers in
// well under a second; only a worker that will never answer reaches this.
const TASK_TIMEOUT_MS = 60_000;
// Consecutive worker failures before the session gives up on workers: one bad
// file or hiccup must not slow every later import, but a bundle that crashes
// on load must not respawn forever.
const MAX_CONSECUTIVE_FAILURES = 3;

const slots: WorkerSlot[] = [];
const queue: { input: ThumbTaskInput; resolve: (r: ThumbTaskResult) => void }[] = [];
let broken = false;
let failures = 0;

/** Leaves headroom for the main thread, the libraw pool and the cache worker. */
export function importPoolSize(): number {
  const hc =
    (typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 0) || 4;
  return Math.min(6, Math.max(2, hc - 4));
}

const inline = (input: ThumbTaskInput): Promise<ThumbTaskResult> =>
  runThumbTask(input).catch((): ThumbTaskResult => ({ ok: false }));

function spawnSlot(): WorkerSlot | null {
  try {
    const worker = new Worker(new URL("./import-thumb.worker.ts", import.meta.url), {
      type: "module",
    });
    const slot: WorkerSlot = { worker, busy: false, currentResolve: null, timer: null };
    worker.onmessage = (e: MessageEvent<ThumbTaskResult>) => {
      if (!slots.includes(slot)) return;
      const resolve = slot.currentResolve;
      clearTimeout(slot.timer ?? undefined);
      slot.timer = null;
      slot.currentResolve = null;
      slot.busy = false;
      failures = 0;
      resolve?.(e.data);
      drain(slot);
    };
    worker.onerror = () => failAll();
    slots.push(slot);
    return slot;
  } catch {
    broken = true;
    return null;
  }
}

function noteFailure(): void {
  if (++failures >= MAX_CONSECUTIVE_FAILURES) broken = true;
}

// One at a time: each inline decode holds a whole file on the main thread.
async function flushQueueInline(): Promise<void> {
  for (let t = queue.shift(); t; t = queue.shift()) t.resolve(await inline(t.input));
}

// One worker failing to load usually means the worker bundle is broken for all
// of them. In-flight tasks resolve { ok: false } (their buffers were
// transferred away); queued tasks still own their buffers and finish inline.
function failAll(): void {
  noteFailure();
  for (const s of slots) {
    clearTimeout(s.timer ?? undefined);
    s.timer = null;
    s.currentResolve?.({ ok: false });
    s.currentResolve = null;
    s.worker.terminate();
  }
  slots.length = 0;
  flushQueueInline();
}

// A stalled worker holds a transferred buffer it will never return, so only
// that worker goes; its task resolves { ok: false } and a fresh worker takes
// over the queue.
function timeOut(slot: WorkerSlot): void {
  if (!slots.includes(slot)) return;
  const resolve = slot.currentResolve;
  slot.currentResolve = null;
  slot.timer = null;
  slot.worker.terminate();
  slots.splice(slots.indexOf(slot), 1);
  noteFailure();
  resolve?.({ ok: false });
  if (!broken && queue.length > 0) {
    const replacement = spawnSlot();
    if (replacement) drain(replacement);
  }
  if (broken) flushQueueInline();
}

function dispatch(
  slot: WorkerSlot,
  input: ThumbTaskInput,
  resolve: (r: ThumbTaskResult) => void,
): void {
  slot.busy = true;
  slot.currentResolve = resolve;
  slot.timer = setTimeout(() => timeOut(slot), TASK_TIMEOUT_MS);
  slot.worker.postMessage(input, [input.buffer]);
}

function drain(slot: WorkerSlot): void {
  if (broken || slot.busy) return;
  const next = queue.shift();
  if (next) dispatch(slot, next.input, next.resolve);
}

export function processThumb(input: ThumbTaskInput): Promise<ThumbTaskResult> {
  if (broken || typeof Worker === "undefined") return inline(input);
  return new Promise((resolve) => {
    const free = slots.find((s) => !s.busy);
    if (free) return dispatch(free, input, resolve);
    if (slots.length < importPoolSize()) {
      const slot = spawnSlot();
      if (slot) return dispatch(slot, input, resolve);
      void inline(input).then(resolve);
      return;
    }
    queue.push({ input, resolve });
  });
}
