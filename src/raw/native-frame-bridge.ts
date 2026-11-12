// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The main thread's side of native-frame-worker.ts. One worker, made on the
// first hold and kept, holds the open photo's native luminance and cuts detail
// gains from it. It runs one cut at a time; of the cuts asked for meanwhile only
// the newest waits, since a view that moved on has no use for the ones before.
// Nothing is ever cut here: without a worker there is no gain.

import type { DetailGain, NativeLuma } from "./native-frame";
import type { NativeCutWant, NativeFrameReply, NativeFrameRequest } from "./native-frame-job";

type Settle = (gain: DetailGain | null) => void;

let worker: Worker | null = null;
let running: { id: number; settle: Settle } | null = null;
let waiting: { want: NativeCutWant; settle: Settle } | null = null;
let nextId = 1;

function post(w: Worker, msg: NativeFrameRequest, transfer: Transferable[] = []): boolean {
  try {
    w.postMessage(msg, transfer);
    return true;
  } catch (err) {
    console.error("[native-frame] the worker refused a message:", err);
    fail();
    return false;
  }
}

function start(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === "undefined") return null;
  let made: Worker;
  try {
    made = new Worker(new URL("./native-frame-worker.ts", import.meta.url), { type: "module" });
  } catch (err) {
    console.error("[native-frame] no worker:", err);
    return null;
  }
  made.onmessage = (e: MessageEvent<NativeFrameReply>) => {
    if (worker !== made || running?.id !== e.data.id) return;
    const { settle } = running;
    running = null;
    settle(e.data.gain);
    pump();
  };
  made.onerror = (e) => {
    if (worker !== made) return;
    console.error(`[native-frame] the worker failed: ${e.message || "no message"}`);
    fail();
  };
  worker = made;
  return made;
}

// The frame went with the worker; the next hold makes another.
function fail(): void {
  const gone = worker;
  worker = null;
  try {
    gone?.terminate();
  } catch {
    // nothing to stop
  }
  const lost = [running?.settle, waiting?.settle];
  running = null;
  waiting = null;
  for (const settle of lost) settle?.(null);
}

function pump(): void {
  if (running || !waiting || !worker) return;
  const next = waiting;
  waiting = null;
  const id = nextId++;
  running = { id, settle: next.settle };
  post(worker, { op: "cut", id, want: next.want });
}

/** Hands `frame` to the worker (its buffer is transferred); it replaces any frame held. */
export function holdNativeLuma(key: string, frame: NativeLuma): void {
  const w = start();
  if (!w) return;
  const buffer = frame.data.buffer;
  post(w, { op: "hold", key, frame }, buffer instanceof ArrayBuffer ? [buffer] : []);
}

/** Lets go of the held frame; with `key`, only when it is that photo's. */
export function dropNativeLuma(key?: string): void {
  if (worker) post(worker, { op: "drop", key });
}

/** Cuts a gain map from the frame held for `key`. Null when none is held for it, the cut is empty, or a newer request overtook this one. */
export function cutNativeGain(want: {
  key: string;
  rect: NativeCutWant["rect"];
  outW: number;
  outH: number;
  baseW: number;
  baseH: number;
}): Promise<DetailGain | null> {
  if (!worker) return Promise.resolve(null);
  return new Promise<DetailGain | null>((resolve) => {
    waiting?.settle(null);
    waiting = { want, settle: resolve };
    pump();
  });
}
