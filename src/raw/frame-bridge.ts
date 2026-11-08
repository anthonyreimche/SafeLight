// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The main thread's side of frame-worker.ts. A decode's pixel work (frame-job.ts)
// goes to a small pool of dedicated workers, its buffers transferred each way, so
// no loop over a frame's pixels and no copy of the frame runs here. Not the cache
// worker, which serializes gzip and serves Develop's reads, and not the libraw
// workers, which are busy decoding. With no Worker, or once the workers prove
// unusable, the same function runs inline.

import {
  handleFrameRequest,
  type FrameJob,
  type FrameReply,
  type FrameRequest,
  type FrameResult,
} from "./frame-job";

const POOL_SIZE = 2;
// Background work (Cache all, the import pass) leaves one worker free for the
// photo the user opens.
const BACKGROUND_LIMIT = POOL_SIZE - 1;
// A conversion of even a 150 MP frame takes seconds; only a worker that will
// never answer reaches this.
const TASK_TIMEOUT_MS = 120_000;

interface Task {
  request: FrameRequest;
  transfer: Transferable[];
  background: boolean;
  settle: (reply: FrameReply | Error) => void;
}

interface Slot {
  worker: Worker;
  task: Task | null;
  timer: ReturnType<typeof setTimeout> | null;
}

const slots: Slot[] = [];
const waiting: { interactive: Task[]; background: Task[] } = { interactive: [], background: [] };
// Set once the workers can't be had or trusted: every later job runs inline.
let unusable = false;
let nextId = 1;

const backgroundBusy = (): number => slots.filter((s) => s.task?.background).length;

function spawn(): Slot | null {
  try {
    const worker = new Worker(new URL("./frame-worker.ts", import.meta.url), { type: "module" });
    const slot: Slot = { worker, task: null, timer: null };
    worker.onmessage = (e: MessageEvent<FrameReply>) => {
      const task = slot.task;
      if (!task || e.data.id !== task.request.id) return;
      clearTimeout(slot.timer ?? undefined);
      slot.task = null;
      slot.timer = null;
      task.settle(e.data);
      pump();
    };
    worker.onerror = (e) => retire(`frame worker failed: ${e.message || "no message"}`);
    slots.push(slot);
    return slot;
  } catch {
    giveUp();
    return null;
  }
}

// A worker that is already gone, or never was one, has nothing to stop.
function stop(worker: Worker): void {
  try {
    worker.terminate();
  } catch {
    // nothing to stop
  }
}

function runInline(task: Task): void {
  task.settle(handleFrameRequest(task.request).reply);
}

// What the workers still hold is lost with them (its buffers were transferred);
// what waits still has its buffers and runs inline.
function giveUp(): void {
  unusable = true;
  for (const t of [...waiting.interactive, ...waiting.background]) runInline(t);
  waiting.interactive = [];
  waiting.background = [];
}

function retire(reason: string): void {
  const lost = slots.splice(0).map((s) => {
    clearTimeout(s.timer ?? undefined);
    stop(s.worker);
    return s.task;
  });
  for (const task of lost) task?.settle(new Error(reason));
  giveUp();
}

function timeOut(slot: Slot): void {
  if (!slots.includes(slot)) return;
  slots.splice(slots.indexOf(slot), 1);
  stop(slot.worker);
  slot.task?.settle(new Error("the frame worker gave no answer"));
  pump();
}

function dispatch(slot: Slot, task: Task): void {
  slot.task = task;
  try {
    slot.worker.postMessage(task.request, task.transfer);
  } catch {
    // Refused before anything moved (a value that can't be transferred, or no
    // real worker): the buffers are still here, so this job alone runs inline.
    slot.task = null;
    runInline(task);
    return;
  }
  slot.timer = setTimeout(() => timeOut(slot), TASK_TIMEOUT_MS);
}

function next(): Task | undefined {
  const interactive = waiting.interactive.shift();
  if (interactive) return interactive;
  return backgroundBusy() < BACKGROUND_LIMIT ? waiting.background.shift() : undefined;
}

function pump(): void {
  while (!unusable && (waiting.interactive.length > 0 || waiting.background.length > 0)) {
    const slot = slots.find((s) => !s.task) ?? (slots.length < POOL_SIZE ? spawn() : null);
    if (!slot) return;
    const task = next();
    if (!task) return;
    dispatch(slot, task);
  }
}

const abandoned = (): DOMException => new DOMException("the decode was abandoned", "AbortError");

/** Whether `e` is the refusal of a job whose decode was abandoned while it waited. */
export const isAbandoned = (e: unknown): boolean => e instanceof DOMException && e.name === "AbortError";

// A job whose signal fires while it waits is dropped unsent; one already in a
// worker finishes.
function submit(
  make: (id: number) => FrameRequest,
  transfer: Transferable[],
  priority: FramePriority | undefined,
): Promise<FrameReply> {
  const background = priority?.background ?? false;
  const signal = priority?.signal;
  if (signal?.aborted) return Promise.reject(abandoned());
  const request = make(nextId++);
  return new Promise((resolve, reject) => {
    const drop = () => {
      const queue = background ? waiting.background : waiting.interactive;
      const at = queue.indexOf(task);
      if (at < 0) return;
      queue.splice(at, 1);
      reject(abandoned());
    };
    const task: Task = {
      request,
      transfer,
      background,
      settle: (reply) => {
        signal?.removeEventListener("abort", drop);
        if (reply instanceof Error) reject(reply);
        else resolve(reply);
      },
    };
    if (unusable || typeof Worker === "undefined") return runInline(task);
    (background ? waiting.background : waiting.interactive).push(task);
    signal?.addEventListener("abort", drop, { once: true });
    pump();
  });
}

/** Who waits on a job: background work goes behind an opened photo's, and a job
 *  whose `signal` fires before a worker takes it is dropped. */
export interface FramePriority {
  background?: boolean;
  signal?: AbortSignal;
}

function failure(reply: FrameReply): Error | null {
  return reply.op === "error" ? new Error(reply.message) : null;
}

/** The job's frame, turned upright, with its cache entry when asked for: built
 *  off the main thread. The job's samples are handed to the worker, not copied. */
export async function finishFrame(job: FrameJob, priority?: FramePriority): Promise<FrameResult> {
  const reply = await submit((id) => ({ id, op: "build", job }), [job.pixels.buffer], priority);
  const error = failure(reply);
  if (error) throw error;
  if (reply.op !== "build") throw new Error("the frame worker answered another request");
  return reply.result;
}

/** `data` as 8-bit sRGB RGBA, for a thumbnail; `data` is handed to the worker. */
export async function encodeSrgb8(
  data: Float32Array,
  priority?: { background?: boolean },
): Promise<Uint8ClampedArray<ArrayBuffer>> {
  const reply = await submit((id) => ({ id, op: "srgb8", data }), [data.buffer], {
    background: priority?.background,
  });
  const error = failure(reply);
  if (error) throw error;
  if (reply.op !== "srgb8") throw new Error("the frame worker answered another request");
  return reply.bytes;
}
