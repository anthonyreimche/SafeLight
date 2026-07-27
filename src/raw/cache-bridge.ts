// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { CacheRequest, CacheResponse } from "./cache-worker";

let worker: Worker | null = null;
let ready: Promise<void> | null = null;
let nextId = 1;

const pending = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();

function getWorker(): Worker {
  if (!worker) {
    const w = new Worker(new URL("./cache-worker.ts", import.meta.url), { type: "module" });
    worker = w;
    ready = new Promise<void>((resolve, reject) => {
      const fail = (err: Error) => {
        for (const p of pending.values()) p.reject(err);
        pending.clear();
        if (worker === w) {
          worker = null;
          ready = null;
        }
        reject(err);
      };
      w.onmessage = (e: MessageEvent<CacheResponse>) => {
        const msg = e.data;
        if (msg.type === "ready") {
          resolve();
          w.onmessage = handleMessage;
          return;
        }
        handleMessage(e);
      };
      w.onerror = (e) => fail(new Error(e.message || "cache worker failed"));
      w.onmessageerror = () => fail(new Error("cache worker message deserialisation failed"));
    });
  }
  return worker;
}

function handleMessage(e: MessageEvent<CacheResponse>) {
  const msg = e.data;
  if (!("id" in msg)) return;
  const id = (msg as { id: number }).id;
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (msg.type === "error") {
    p.reject(new Error(msg.message));
  } else {
    p.resolve(msg);
  }
}

function send<T>(msg: CacheRequest, transfer?: Transferable[]): Promise<T> {
  const w = getWorker();
  const r = ready!;
  return r.then(
    () =>
      new Promise<T>((resolve, reject) => {
        if ("id" in msg) {
          pending.set(msg.id, { resolve: resolve as (v: unknown) => void, reject });
        }
        try {
          if (transfer) w.postMessage(msg, transfer);
          else w.postMessage(msg);
        } catch (err) {
          if ("id" in msg) pending.delete(msg.id);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }),
  );
}

export function setCacheDirOnWorker(dir: FileSystemDirectoryHandle | null): void {
  const w = getWorker();
  ready!
    .then(() => {
      try {
        w.postMessage({ cmd: "setCacheDir", dir } satisfies CacheRequest);
      } catch {
        // Some environments (notably an Electron File System Access polyfill)
        // expose directory handles as plain objects that structuredClone can't
        // serialise, so postMessage throws DataCloneError. Fall back to the
        // worker's IndexedDB cache rather than crashing folder open.
        w.postMessage({ cmd: "setCacheDir", dir: null } satisfies CacheRequest);
      }
    })
    .catch(() => {});
}

export async function workerReadCachedPreview(
  key: string,
): Promise<{ data: Uint16Array; width: number; height: number } | null> {
  const id = nextId++;
  const resp = await send<Extract<CacheResponse, { type: "read" }>>(
    { cmd: "read", id, key },
  );
  return resp.data ? { data: resp.data, width: resp.width, height: resp.height } : null;
}

export async function workerWriteCachedPreview(
  key: string,
  data: Float32Array,
  width: number,
  height: number,
  maxEdge: number,
): Promise<void> {
  const id = nextId++;
  const copy = new Float32Array(data);
  await send<Extract<CacheResponse, { type: "write" }>>(
    { cmd: "write", id, key, data: copy, width, height, maxEdge },
    [copy.buffer],
  );
}

export async function workerDeleteCachedPreview(key: string): Promise<void> {
  const id = nextId++;
  await send<Extract<CacheResponse, { type: "delete" }>>({ cmd: "delete", id, key });
}

export async function workerClearRawCache(): Promise<void> {
  const id = nextId++;
  await send<Extract<CacheResponse, { type: "clear" }>>({ cmd: "clear", id });
}

export async function workerCachedKeys(): Promise<string[]> {
  const id = nextId++;
  const resp = await send<Extract<CacheResponse, { type: "keys" }>>({ cmd: "keys", id });
  return resp.keys;
}
