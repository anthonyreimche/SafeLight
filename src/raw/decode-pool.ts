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
let loadFailure: string | undefined;

function getCtor(): Promise<LibRawCtor | null> {
  if (!ctorPromise) {
    ctorPromise = import("libraw-wasm")
      .then((m) => {
        loadFailure = undefined;
        return (m.default ?? null) as LibRawCtor | null;
      })
      .catch((e: unknown) => {
        console.warn("[decode-pool] libraw-wasm import failed", e);
        loadFailure = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        // A later request loads it again; one failed import must not last the session.
        ctorPromise = null;
        return null;
      });
  }
  return ctorPromise;
}

/** Why libraw-wasm could not be loaded, or an instance of it made, on the latest
 *  attempt, if it could not. */
export function decodePoolFailure(): string | undefined {
  return loadFailure;
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
  /** The long edge, in pixels, the caller renders from. A frame whose half
   *  size still reaches it is decoded at half size (libraw's half_size): about
   *  a quarter of the pixels to demosaic and convert. Unset: full size. */
  targetEdge?: number;
  /** Clockwise degrees to bake into a libraw frame, which arrives EXIF-upright:
   *  the photo's manual turns (catalog/orient.ts manualRotation). The turn is
   *  made off the main thread, as the frame is converted. */
  turn?: number;
  /** Also build the develop-preview cache entry for the frame, its preview
   *  downscaled to this long edge, off the main thread (raw-cache.ts). */
  cacheEdge?: number;
  /** Asked once libraw has answered a request whose `signal` fired meanwhile:
   *  the caller that has taken the decode over since, if one has (decode.ts). Its
   *  frame is then built for that caller instead of being dropped. */
  heir?: () => DecodeHeir | null;
}

/** A caller waiting on a decode another caller began and then left. */
export interface DecodeHeir {
  signal?: AbortSignal;
}

// null: the pool was disposed while this request waited.
type Waiter = (inst: LibRawInstance | null) => void;

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
  while (pool.length < DEFAULT_SIZE) {
    const inst = spawn(Ctor);
    if (!inst) break;
    free.push(inst);
  }
  poolSize = pool.length;
}

// Making an instance can fail (its Worker refused, memory exhausted). The pool
// then carries on with the instances it has, and with none, requests get null.
function spawn(Ctor: LibRawCtor): LibRawInstance | null {
  try {
    const inst = new Ctor();
    pool.push(inst);
    return inst;
  } catch (e: unknown) {
    console.warn("[decode-pool] libraw instance could not be made", e);
    loadFailure = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return null;
  }
}

/** A free instance, or a fresh one in the place of one that was discarded. */
function takeFree(): LibRawInstance | undefined {
  const inst = free.pop();
  if (inst) return inst;
  return (ctor && pool.length < poolSize && spawn(ctor)) || undefined;
}

export function warmDecodePool(): Promise<void> {
  if (!warming) {
    const attempt: Promise<void> = ensurePool().finally(() => {
      if (warming === attempt && poolSize === 0) warming = null;
    });
    warming = attempt;
  }
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
      stopRecycleTimer();
      if (background) heldByBackground.add(inst);
      return inst;
    }
  }
  // No replacement could be made and nothing is left to release.
  if (pool.length === 0) return null;

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

// WASM memory only grows: an instance that decoded a big frame keeps that heap
// for the session. Such an instance is ended once the pool has been idle a while
// (not at release, which would cost a 45 MP shooter a spawn on every open).
const HEAVY_PEAK_BYTES = 640_000_000;
const RECYCLE_IDLE_MS = 30_000;
const heavy = new Set<LibRawInstance>();
let recycleTimer: ReturnType<typeof setTimeout> | undefined;

function stopRecycleTimer(): void {
  clearTimeout(recycleTimer);
  recycleTimer = undefined;
}

function recycleHeavy(): void {
  recycleTimer = undefined;
  if (free.length !== pool.length) return;
  for (const inst of [...heavy]) {
    heavy.delete(inst);
    free = free.filter((f) => f !== inst);
    discardInstance(inst);
    const fresh = ctor && spawn(ctor);
    if (fresh) free.push(fresh);
  }
}

/** `peakBytes` is the most of the instance's heap the decode just finished may
 *  have needed; a big one marks the instance for recycling. */
export function releaseInstance(inst: LibRawInstance, peakBytes = 0): void {
  heldByBackground.delete(inst);
  // A discarded instance, or one from before the pool was disposed.
  if (!pool.includes(inst)) return;
  if (peakBytes > HEAVY_PEAK_BYTES) heavy.add(inst);
  handOn(inst);
  if (heavy.size > 0 && free.length === pool.length && recycleTimer === undefined) {
    recycleTimer = setTimeout(recycleHeavy, RECYCLE_IDLE_MS);
  }
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
  heavy.delete(inst);
  try { inst.worker?.terminate(); } catch {}
  const at = pool.indexOf(inst);
  if (at < 0) return;
  pool.splice(at, 1);
  const servable =
    waitingInteractive.length > 0 ||
    (waitingBackground.length > 0 && heldByBackground.size < backgroundLimit());
  if (!ctor || !servable) return;
  const fresh = spawn(ctor);
  if (fresh) {
    handOn(fresh);
    return;
  }
  // With no instance left, no release will ever come for them.
  if (pool.length > 0) return;
  const stranded = [...waitingInteractive, ...waitingBackground];
  waitingInteractive = [];
  waitingBackground = [];
  for (const wake of stranded) wake(null);
}

export function decodePoolSize(): number {
  return poolSize;
}

export function disposeDecodePool(): void {
  const stranded = [...waitingInteractive, ...waitingBackground];
  waitingInteractive = [];
  waitingBackground = [];
  for (const wake of stranded) wake(null);
  heldByBackground.clear();
  heavy.clear();
  stopRecycleTimer();
  for (const inst of pool) {
    try { inst.worker?.terminate(); } catch {}
  }
  pool = [];
  free = [];
  poolSize = 0;
  warming = null;
  ctor = null;
  ctorPromise = null;
  loadFailure = undefined;
}
