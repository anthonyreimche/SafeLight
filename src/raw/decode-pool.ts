// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Persistent pool of libraw-wasm instances. Each instance owns a Web Worker +
// WASM heap; re-using them across decodes eliminates the 50-300ms init cost
// that a fresh `new LibRaw()` pays every time. Instances are acquired/released
// like a connection pool: at most three decodes run at once, the rest queue.
// Call `warmDecodePool()` at app startup for instant first decode.

export type LibRawInstance = {
  open(data: Uint8Array, settings?: Record<string, unknown>): Promise<void>;
  // undefined when LibRaw failed: its C++ errors reach JS without a message.
  metadata(full?: boolean): Promise<Record<string, unknown> | undefined>;
  imageData(): Promise<unknown>;
  worker?: Worker;
};
type LibRawCtor = new () => LibRawInstance;

let ctorPromise: Promise<LibRawCtor | null> | null = null;
// Kept once loaded, so a discarded instance can be replaced without waiting.
let ctor: LibRawCtor | null = null;

function getCtor(): Promise<LibRawCtor | null> {
  if (!ctorPromise) {
    ctorPromise = import("libraw-wasm")
      .then((m) => (m.default ?? null) as LibRawCtor | null)
      .catch((e) => {
        console.warn("[decode-pool] libraw-wasm import failed", e);
        return null;
      });
  }
  return ctorPromise;
}

const DEFAULT_SIZE = 3;

// Background work shares the pool with the photo the user is looking at: the
// "Cache all" pre-decode, the preview repair and rebuild, grid previews built
// from the file, Develop's neighbour prefetch, edited-thumbnail regeneration
// and off-screen measuring (renderPhotoFrame: batch Auto, samplers). A
// background request waits behind every interactive one, and background work
// never holds every instance, so an opened photo waits only when other
// interactive decodes are running; each class is served first-come.
interface DecodePriority {
  background?: boolean;
}

// `signal` abandons a request still waiting for an instance (the user moved on
// from the photo): it leaves the queue and resolves null. An instance already
// handed out stays with its decode to the end; libraw can't be interrupted, and
// the finished decode still fills the cache. (Only a hung or failed call ends
// an instance early; see discardInstance.)
export interface DecodeRequest extends DecodePriority {
  signal?: AbortSignal;
}

type Waiter = (inst: LibRawInstance) => void;

let pool: LibRawInstance[] = [];
let free: LibRawInstance[] = [];
let waitingInteractive: Waiter[] = [];
let waitingBackground: Waiter[] = [];
const heldByBackground = new Set<LibRawInstance>();
let poolSize = 0;
let warming: Promise<void> | null = null;

const backgroundLimit = (): number => Math.max(1, poolSize - 1);

async function ensurePool(): Promise<void> {
  if (typeof Worker === "undefined" || typeof SharedArrayBuffer === "undefined") return;
  const Ctor = await getCtor();
  if (!Ctor) return;
  ctor = Ctor;
  while (pool.length < DEFAULT_SIZE) free.push(spawn(Ctor));
  poolSize = pool.length;
}

function spawn(Ctor: LibRawCtor): LibRawInstance {
  const inst = new Ctor();
  pool.push(inst);
  return inst;
}

/** A free instance, or a fresh one in the place of one that was discarded. */
function takeFree(): LibRawInstance | undefined {
  const inst = free.pop();
  if (inst) return inst;
  return ctor && pool.length < poolSize ? spawn(ctor) : undefined;
}

export function warmDecodePool(): Promise<void> {
  warming ??= ensurePool();
  return warming;
}

export async function acquireInstance(
  request?: DecodeRequest,
): Promise<LibRawInstance | null> {
  await warmDecodePool();
  // The pool's size, not its live instances: every one may have been discarded
  // with nobody waiting, and takeFree() then makes their replacements.
  if (poolSize === 0) return null;
  const signal = request?.signal;
  if (signal?.aborted) return null;

  const background = request?.background ?? false;
  if (!background || heldByBackground.size < backgroundLimit()) {
    const inst = takeFree();
    if (inst) {
      if (background) heldByBackground.add(inst);
      return inst;
    }
  }

  const queue = background ? waitingBackground : waitingInteractive;
  return new Promise<LibRawInstance | null>((resolve) => {
    const abandon = (): void => {
      const at = queue.indexOf(grant);
      if (at >= 0) queue.splice(at, 1);
      resolve(null);
    };
    const grant: Waiter = (inst) => {
      signal?.removeEventListener("abort", abandon);
      resolve(inst);
    };
    queue.push(grant);
    signal?.addEventListener("abort", abandon, { once: true });
  });
}

export function releaseInstance(inst: LibRawInstance): void {
  heldByBackground.delete(inst);
  // A discarded instance, or one from before the pool was disposed.
  if (!pool.includes(inst)) return;
  handOn(inst);
}

// Interactive waiters first; a background waiter only while background work is
// under its cap, so the instance stays reserved for the next opened photo.
function handOn(inst: LibRawInstance): void {
  const interactive = waitingInteractive.shift();
  if (interactive) {
    interactive(inst);
    return;
  }
  const background =
    heldByBackground.size < backgroundLimit() ? waitingBackground.shift() : undefined;
  if (background) {
    heldByBackground.add(inst);
    background(inst);
    return;
  }
  free.push(inst);
}

/**
 * Ends an instance whose call failed or hung, instead of releasing it: a trap
 * or an abort leaves its module unusable, and a hung worker never answers. A
 * fresh instance takes its place once one is needed, at once if someone waits,
 * so the pool keeps its size.
 */
export function discardInstance(inst: LibRawInstance): void {
  heldByBackground.delete(inst);
  try { inst.worker?.terminate(); } catch {}
  const at = pool.indexOf(inst);
  if (at < 0) return;
  pool.splice(at, 1);
  const servable =
    waitingInteractive.length > 0 ||
    (waitingBackground.length > 0 && heldByBackground.size < backgroundLimit());
  if (ctor && servable) handOn(spawn(ctor));
}

export function decodePoolSize(): number {
  return poolSize;
}

export function disposeDecodePool(): void {
  waitingInteractive = [];
  waitingBackground = [];
  heldByBackground.clear();
  for (const inst of pool) {
    try { inst.worker?.terminate(); } catch {}
  }
  pool = [];
  free = [];
  poolSize = 0;
  warming = null;
  ctor = null;
}
