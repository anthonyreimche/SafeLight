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
// any worker-level error resolves as { ok: false } — the caller's inline
// decode chain takes over, so a broken worker bundle can slow imports but
// never lose photos.

import {
  runThumbTask,
  type ThumbTaskInput,
  type ThumbTaskResult,
} from "./import-thumb-task";

interface WorkerSlot {
  worker: Worker;
  busy: boolean;
  currentResolve: ((r: ThumbTaskResult) => void) | null;
}

const slots: WorkerSlot[] = [];
const queue: { input: ThumbTaskInput; resolve: (r: ThumbTaskResult) => void }[] = [];
let broken = false;

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
    const slot: WorkerSlot = { worker, busy: false, currentResolve: null };
    worker.onmessage = (e: MessageEvent<ThumbTaskResult>) => {
      const resolve = slot.currentResolve;
      slot.currentResolve = null;
      slot.busy = false;
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

// One worker failing to load usually means the worker bundle is broken for all
// of them. In-flight tasks resolve { ok: false } (their buffers were
// transferred away); queued tasks still own their buffers and finish inline.
function failAll(): void {
  broken = true;
  for (const s of slots) {
    s.currentResolve?.({ ok: false });
    s.currentResolve = null;
    s.worker.terminate();
  }
  slots.length = 0;
  for (const t of queue.splice(0)) void inline(t.input).then(t.resolve);
}

function dispatch(
  slot: WorkerSlot,
  input: ThumbTaskInput,
  resolve: (r: ThumbTaskResult) => void,
): void {
  slot.busy = true;
  slot.currentResolve = resolve;
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
