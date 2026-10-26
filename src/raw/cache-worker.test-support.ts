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

interface Transaction {
  oncomplete: Handler;
  onabort: Handler;
  error: Error | null;
  /** Requests answered so far; the commit waits for the last one. */
  answered: number;
  objectStore: () => ReturnType<typeof storeOf>;
}

function request<T>(run: () => T, tx: Transaction, commit: () => void) {
  const req: { result?: T; onsuccess: Handler; onerror: Handler } =
    { onsuccess: null, onerror: null };
  queueMicrotask(() => {
    req.result = run();
    req.onsuccess?.();
    // A request is answered before its transaction commits, as in IndexedDB:
    // a failure at the commit (the quota, say) reaches the transaction, not it.
    const answered = ++tx.answered;
    queueMicrotask(() => {
      if (tx.answered === answered) commit();
    });
  });
  return req;
}

const FakeKeyRange = { bound: (lower: string, upper: string): KeyRange => ({ lower, upper }) };

function storeOf(rows: Map<string, Row>, tx: Transaction, commit: () => void) {
  return {
    get: (key: string) => request(() => rows.get(key), tx, commit),
    put: (row: Row) => request(() => void rows.set(row.key, row), tx, commit),
    delete: (key: string) => request(() => void rows.delete(key), tx, commit),
    clear: () => request(() => rows.clear(), tx, commit),
    getAllKeys: (r?: KeyRange) =>
      request(
        () => [...rows.keys()].filter((k) => !r || (k >= r.lower && k <= r.upper)),
        tx,
        commit,
      ),
    getAll: (r?: KeyRange) =>
      request(
        () =>
          [...rows.entries()]
            .filter(([k]) => !r || (k >= r.lower && k <= r.upper))
            .map(([, row]) => row),
        tx,
        commit,
      ),
  };
}

function connection(rows: Map<string, Row>, commitError: () => Error | null) {
  const db = {
    closed: false,
    onversionchange: null as Handler,
    objectStoreNames: { contains: () => true },
    deleteObjectStore: () => rows.clear(),
    createObjectStore: () => {},
    close: () => void (db.closed = true),
    transaction: (): Transaction => {
      if (db.closed) throw new DOMException("The connection is closed.", "InvalidStateError");
      const before = new Map(rows);
      const commit = () => {
        const error = commitError();
        if (!error) return tx.oncomplete?.();
        // The transaction rolls back and aborts.
        rows.clear();
        before.forEach((row, key) => rows.set(key, row));
        tx.error = error;
        tx.onabort?.();
      };
      const tx: Transaction = {
        oncomplete: null,
        onabort: null,
        error: null,
        answered: 0,
        objectStore: () => storeOf(rows, tx, commit),
      };
      return tx;
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
  /** Why each transaction fails to commit, until cleared: the quota ran out. */
  commitError: Error | null = null;

  open(_name: string, version: number) {
    this.opens++;
    const req = { result: connection(this.rows, () => this.commitError), onupgradeneeded: null as Handler,
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
