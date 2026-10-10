// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The cache worker run in-process: its module evaluated afresh against a fake
// host (its folder, scope and connection live in module scope), with an
// optional in-memory IndexedDB that outlives it, as the real database outlives
// a page load.

import { vi } from "vitest";
import type { CacheRequest, CacheResponse } from "./cache-worker";

type Handler = (() => void) | null;
type Row = { key: string };
type KeyRange = { lower: string; upper: string };

function request<T>(run: () => T) {
  const req: { result?: T; onsuccess: Handler; onerror: Handler } =
    { onsuccess: null, onerror: null };
  queueMicrotask(() => {
    req.result = run();
    req.onsuccess?.();
  });
  return req;
}

const FakeKeyRange = { bound: (lower: string, upper: string): KeyRange => ({ lower, upper }) };

function connection(rows: Map<string, Row>) {
  const store = {
    get: (key: string) => request(() => rows.get(key)),
    put: (row: Row) => request(() => void rows.set(row.key, row)),
    delete: (key: string) => request(() => void rows.delete(key)),
    clear: () => request(() => rows.clear()),
    getAllKeys: (r?: KeyRange) =>
      request(() => [...rows.keys()].filter((k) => !r || (k >= r.lower && k <= r.upper))),
  };
  const db = {
    closed: false,
    onversionchange: null as Handler,
    objectStoreNames: { contains: () => true },
    deleteObjectStore: () => rows.clear(),
    createObjectStore: () => {},
    close: () => void (db.closed = true),
    transaction: () => {
      if (db.closed) throw new DOMException("The connection is closed.", "InvalidStateError");
      return { objectStore: () => store };
    },
  };
  return db;
}

/** The slice of IndexedDB cache-worker.ts uses: one store keyed by "key",
 *  version upgrades, and the blocked / versionchange events. Opens queue per
 *  database: only the head hears "blocked"; later ones wait silently behind it. */
export class FakeIndexedDB {
  readonly rows = new Map<string, Row>();
  readonly connections: ReturnType<typeof connection>[] = [];
  private readonly queue: (() => void)[] = [];
  opens = 0;
  version = 0;
  /** Another window holds an older version open and ignores versionchange. */
  blockOpens = false;
  /** That window finally closes, so the blocked open goes through. */
  release = () => {};

  open(_name: string, version: number) {
    this.opens++;
    const req = { result: connection(this.rows), onupgradeneeded: null as Handler,
      onsuccess: null as Handler, onerror: null as Handler, onblocked: null as Handler };
    const finish = () => {
      if (version > this.version) {
        this.version = version;
        req.onupgradeneeded?.();
      }
      this.connections.push(req.result);
      req.onsuccess?.();
      this.queue.shift();
      if (this.queue.length) queueMicrotask(this.queue[0]);
    };
    this.queue.push(() => {
      if (!this.blockOpens) return finish();
      this.release = () => {
        this.blockOpens = false;
        finish();
      };
      req.onblocked?.();
    });
    if (this.queue.length === 1) queueMicrotask(this.queue[0]);
    return req;
  }
}

interface WorkerHost {
  postMessage: (msg: CacheResponse, transfer?: Transferable[]) => void;
  onmessage: ((e: MessageEvent<CacheRequest>) => unknown) | null;
}

/** A fresh cache worker. `post` resolves once the worker has handled the
 *  message; `send` also answers its last reply, `reply` the one to `id`, and
 *  `replies` every reply so far. */
export async function startCacheWorker(idb?: FakeIndexedDB) {
  vi.resetModules();
  const postMessage = vi.fn<WorkerHost["postMessage"]>();
  const host: WorkerHost = { postMessage, onmessage: null };
  vi.stubGlobal("self", host);
  if (idb) {
    vi.stubGlobal("indexedDB", idb);
    vi.stubGlobal("IDBKeyRange", FakeKeyRange);
  }
  await import("./cache-worker");
  const handler = host.onmessage;
  if (!handler) throw new Error("cache worker installed no message handler");

  const post = async (msg: CacheRequest) => {
    await handler(new MessageEvent("message", { data: msg }));
  };
  const replies = () => postMessage.mock.calls.map(([r]) => r);
  const lastReply = () => replies().at(-1);
  const send = async (msg: CacheRequest) => {
    await post(msg);
    return lastReply();
  };
  const reply = (id: number) => replies().find((r) => "id" in r && r.id === id);
  return { post, send, reply, lastReply, replies };
}
