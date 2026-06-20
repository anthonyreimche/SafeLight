// Persistent pool of libraw-wasm instances. Each instance owns a Web Worker +
// WASM heap; re-using them across decodes eliminates the 50-300ms init cost
// that a fresh `new LibRaw()` pays every time. Instances are acquired/released
// like a connection pool — at most `size` decodes run concurrently, the rest
// queue. Call `warmDecodePool()` at app startup for instant first decode.

type LibRawInstance = {
  open(data: Uint8Array, settings?: Record<string, unknown>): Promise<void>;
  metadata(full?: boolean): Promise<Record<string, unknown>>;
  imageData(): Promise<unknown>;
  worker?: Worker;
};
type LibRawCtor = new () => LibRawInstance;

let ctorPromise: Promise<LibRawCtor | null> | null = null;

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

let pool: LibRawInstance[] = [];
let free: LibRawInstance[] = [];
let waiting: Array<(inst: LibRawInstance) => void> = [];
let poolSize = 0;
let warming: Promise<void> | null = null;

async function ensurePool(size: number = DEFAULT_SIZE): Promise<void> {
  if (pool.length >= size) return;
  if (typeof Worker === "undefined" || typeof SharedArrayBuffer === "undefined") return;
  const Ctor = await getCtor();
  if (!Ctor) return;
  while (pool.length < size) {
    const inst = new Ctor();
    pool.push(inst);
    free.push(inst);
  }
  poolSize = pool.length;
}

export function warmDecodePool(size: number = DEFAULT_SIZE): Promise<void> {
  if (!warming) {
    warming = ensurePool(size);
  }
  return warming;
}

export async function acquireInstance(): Promise<LibRawInstance | null> {
  await warmDecodePool();
  if (pool.length === 0) return null;

  const inst = free.pop();
  if (inst) return inst;

  return new Promise<LibRawInstance>((resolve) => {
    waiting.push(resolve);
  });
}

export function releaseInstance(inst: LibRawInstance): void {
  const waiter = waiting.shift();
  if (waiter) {
    waiter(inst);
  } else {
    free.push(inst);
  }
}

export function decodePoolSize(): number {
  return poolSize;
}

export function disposeDecodePool(): void {
  waiting = [];
  for (const inst of pool) {
    try { inst.worker?.terminate(); } catch {}
  }
  pool = [];
  free = [];
  poolSize = 0;
  warming = null;
}
