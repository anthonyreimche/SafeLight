// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Shared variables (api.variables): named JSON values any extension can
// register, read, subscribe to and write. Each window holds a replica, kept in
// step with the others over a transport (a BroadcastChannel in the app; see
// variables-host.ts).
//
// Writes use optimistic locking. Each window remembers, per extension, the
// latest revision of each variable that extension has seen (from register,
// get, a delivery, or its own write); a set() from an extension that hasn't
// seen the current revision is refused and reported. update(fn) runs on the
// current value, so it is never stale within a window. When two windows write
// at once, the higher revision wins everywhere and the window whose write lost
// reports it.

import type {
  SharedVariablesAPI,
  VariableRevision,
  VariableSnapshot,
  VariableWriteResult,
  VariableWriter,
} from "./types";
import { estimateSize, frozenCopy, jsonEqual, nameProblem, valueProblem } from "./variables-values";

export const HISTORY_LIMIT = 50;
export const LARGE_VALUE_BYTES = 8 * 1024 * 1024;

export type VariableOutcome = "accepted" | "stale" | "invalid" | "lost";

export interface VariableHistoryItem {
  time: number;
  writer: VariableWriter;
  /** accepted and lost: the write's own revision. stale and invalid: the
   *  current revision the write was refused against. */
  revision: VariableRevision;
  outcome: VariableOutcome;
  /** stale: who wrote the revision the writer hadn't seen. lost: who won. */
  other?: VariableWriter;
  /** invalid: why. */
  message?: string;
}

export interface WindowInfo {
  id: string;
  /** "main", a pop-out's module id, or "Developer Tools". */
  label: string;
}

export interface WireEntry {
  name: string;
  value: unknown;
  revision: VariableRevision;
  writer: VariableWriter;
  registeredBy: VariableWriter;
  description?: string;
  history: VariableHistoryItem[];
}

export type VariableMessage =
  | {
      type: "write";
      from: WindowInfo;
      time: number;
      name: string;
      value: unknown;
      revision: VariableRevision;
      /** The revision this write replaced in its own window; null for a registration. */
      basedOn: VariableRevision | null;
      writer: VariableWriter;
      registeredBy: VariableWriter;
      description?: string;
    }
  | { type: "outcome"; from: WindowInfo; name: string; item: VariableHistoryItem }
  | { type: "hello"; from: WindowInfo }
  | { type: "answer"; from: WindowInfo; to: string; entries: WireEntry[] };

export interface VariableTransport {
  post(message: VariableMessage): void;
  /** Messages from other windows only, never this window's own posts. */
  listen(handler: (message: VariableMessage) => void): () => void;
}

export interface VariableInspection {
  snapshot: VariableSnapshot<unknown>;
  size: number;
  history: readonly VariableHistoryItem[];
  /** Extension ids subscribed in this window, in subscription order. */
  subscribers: string[];
}

export interface VariableRegistry {
  /** The api.variables an extension gets. */
  scoped(extension: string): SharedVariablesAPI;
  /** Forget a disabled extension's subscriptions and what it has seen. */
  dropExtension(extension: string): void;
  inspect(): VariableInspection[];
  /** For useSyncExternalStore: fires on every change the Variables tab shows. */
  subscribeChanges(listener: () => void): () => void;
  changeCount(): number;
  /** "this window", another window's label, or the first four characters of its id. */
  windowName(id: string): string;
  dispose(): void;
}

export interface RegistryOptions {
  window: WindowInfo;
  /** null: this window alone (tests, or no BroadcastChannel). */
  transport?: VariableTransport | null;
  warn?: (message: string) => void;
  now?: () => number;
}

interface Entry {
  name: string;
  value: unknown;
  revision: VariableRevision;
  writer: VariableWriter;
  registeredBy: VariableWriter;
  description?: string;
  size: number;
  history: VariableHistoryItem[];
  snapshot: VariableSnapshot<unknown>;
}

type EntryFields = Pick<Entry, "name" | "value" | "revision" | "writer" | "registeredBy" | "description">;

interface Subscriber {
  extension: string;
  listener: (snapshot: VariableSnapshot<unknown>) => void;
}

/** Higher n wins; an equal n is broken by window id. */
export function compareRevisions(a: VariableRevision, b: VariableRevision): number {
  if (a.n !== b.n) return a.n - b.n;
  return a.window < b.window ? -1 : a.window > b.window ? 1 : 0;
}

function sameRevision(a: VariableRevision | null | undefined, b: VariableRevision): boolean {
  return !!a && a.n === b.n && a.window === b.window;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isThenable(v: unknown): boolean {
  return typeof v === "object" && v !== null && typeof (v as { then?: unknown }).then === "function";
}

function snapshotOf(f: EntryFields): VariableSnapshot<unknown> {
  return Object.freeze({
    name: f.name,
    value: f.value,
    revision: Object.freeze({ ...f.revision }),
    writer: Object.freeze({ ...f.writer }),
    registeredBy: Object.freeze({ ...f.registeredBy }),
    ...(f.description !== undefined ? { description: f.description } : {}),
  });
}

function mergeHistories(a: readonly VariableHistoryItem[], b: readonly VariableHistoryItem[]): VariableHistoryItem[] {
  const key = (h: VariableHistoryItem) =>
    `${h.outcome}|${h.time}|${h.revision.n}|${h.revision.window}|${h.writer.extension}|${h.writer.window}`;
  const byKey = new Map<string, VariableHistoryItem>();
  for (const h of [...a, ...b]) byKey.set(key(h), h);
  return [...byKey.values()].sort((x, y) => x.time - y.time).slice(-HISTORY_LIMIT);
}

export function createVariableRegistry(options: RegistryOptions): VariableRegistry {
  const self = options.window;
  const transport = options.transport ?? null;
  const warn = options.warn ?? ((m: string) => console.warn(m));
  const now = options.now ?? Date.now;

  const entries = new Map<string, Entry>();
  const subscribers = new Map<string, Subscriber[]>();
  const seen = new Map<string, Map<string, VariableRevision>>();
  const labels = new Map<string, string>([[self.id, self.label]]);
  const largeReported = new Set<string>();
  const scopes = new Map<string, SharedVariablesAPI>();
  const changeListeners = new Set<() => void>();
  let changes = 0;
  const queue: { snapshot: VariableSnapshot<unknown>; to: Subscriber[] }[] = [];
  let delivering = false;

  const post = (m: VariableMessage) => transport?.post(m);

  function changed(): void {
    changes++;
    for (const l of [...changeListeners]) l();
  }

  function windowName(id: string): string {
    if (id === self.id) return "this window";
    return labels.get(id) ?? id.slice(0, 4);
  }

  function who(w: VariableWriter): string {
    return w.window === self.id ? w.extension : `${w.extension} in window ${windowName(w.window)}`;
  }

  // Only ever moves forward: a queued delivery of an older revision can reach an
  // extension after it has already written or been handed a newer one.
  function markSeen(extension: string, name: string, revision: VariableRevision): void {
    let byName = seen.get(extension);
    if (!byName) seen.set(extension, (byName = new Map()));
    const prev = byName.get(name);
    if (!prev || compareRevisions(revision, prev) > 0) byName.set(name, revision);
  }

  function record(e: Entry, item: VariableHistoryItem): void {
    e.history.push(item);
    if (e.history.length > HISTORY_LIMIT) e.history.splice(0, e.history.length - HISTORY_LIMIT);
  }

  function put(fields: EntryFields, history: VariableHistoryItem[]): Entry {
    const e: Entry = { ...fields, size: estimateSize(fields.value), history, snapshot: snapshotOf(fields) };
    entries.set(fields.name, e);
    return e;
  }

  // A write made by a listener is decided at once but delivered after the
  // delivery in progress, so every subscriber gets every revision in order.
  // Recipients are fixed when a delivery is queued: someone subscribing later
  // already got the current value from subscribe().
  function deliver(snapshot: VariableSnapshot<unknown>, to: readonly Subscriber[]): void {
    if (to.length === 0) return;
    queue.push({ snapshot, to: [...to] });
    if (delivering) return;
    delivering = true;
    try {
      for (let d = queue.shift(); d; d = queue.shift()) {
        for (const s of d.to) {
          if (!subscribers.get(d.snapshot.name)?.includes(s)) continue;
          markSeen(s.extension, d.snapshot.name, d.snapshot.revision);
          try {
            s.listener(d.snapshot);
          } catch (err) {
            warn(`[variables] ${d.snapshot.name}: a subscriber of ${s.extension} threw: ${errorText(err)}`);
          }
        }
      }
    } finally {
      delivering = false;
    }
  }

  function reportLarge(e: Entry): void {
    if (e.size <= LARGE_VALUE_BYTES || largeReported.has(e.name)) return;
    largeReported.add(e.name);
    warn(
      `[variables] ${e.name}: ${(e.size / 1048576).toFixed(1)} MB written by ${e.writer.extension} — values this large are copied to every window.`,
    );
  }

  function accept(extension: string, e: Entry, value: unknown): VariableRevision {
    const time = now();
    const writer: VariableWriter = { extension, window: self.id };
    const revision: VariableRevision = { n: e.revision.n + 1, window: self.id };
    const next = put(
      { name: e.name, value, revision, writer, registeredBy: e.registeredBy, description: e.description },
      e.history,
    );
    record(next, { time, writer, revision, outcome: "accepted" });
    markSeen(extension, e.name, revision);
    reportLarge(next);
    post({
      type: "write",
      from: self,
      time,
      name: e.name,
      value,
      revision,
      basedOn: e.revision,
      writer,
      registeredBy: next.registeredBy,
      description: next.description,
    });
    changed();
    deliver(next.snapshot, subscribers.get(e.name) ?? []);
    return revision;
  }

  function refuse(extension: string, e: Entry, outcome: "stale" | "invalid", detail?: string): void {
    const item: VariableHistoryItem = {
      time: now(),
      writer: { extension, window: self.id },
      revision: e.revision,
      outcome,
      ...(outcome === "stale" ? { other: e.writer } : {}),
      ...(detail !== undefined ? { message: detail } : {}),
    };
    record(e, item);
    post({ type: "outcome", from: self, name: e.name, item });
    changed();
  }

  // A caller's entry can be out of date by now (a listener, getter or update
  // function may have written meanwhile), so the refusal is recorded against
  // whatever entry the name holds at this moment.
  function invalid<T>(extension: string, e: Entry, problem: string): VariableWriteResult<T> {
    warn(`[variables] ${e.name}: write by ${extension} refused — ${problem}.`);
    refuse(extension, entries.get(e.name) ?? e, "invalid", problem);
    return { ok: false, reason: "invalid", message: problem };
  }

  function unregistered<T>(extension: string, name: string): VariableWriteResult<T> {
    warn(`[variables] write by ${extension} to unregistered ${JSON.stringify(name)} refused.`);
    return { ok: false, reason: "unregistered" };
  }

  function scoped(extension: string): SharedVariablesAPI {
    const cached = scopes.get(extension);
    if (cached) return cached;
    const api: SharedVariablesAPI = {
      register<T>(name: string, init: { initial: T; description?: string }): VariableSnapshot<T> {
        const bad = nameProblem(name);
        if (bad) throw new Error(`[variables] ${bad}`);
        const problem = valueProblem(init.initial, "initial");
        if (problem) throw new Error(`[variables] ${name}: ${problem}`);
        // Every write message carries the description, and a value the transport
        // can't clone makes post() throw after the entry is stored, leaving a
        // variable whose writes commit locally but never reach other windows.
        if (init.description !== undefined && typeof init.description !== "string")
          throw new Error(`[variables] ${name}: description must be a string`);
        const existing = entries.get(name);
        if (existing) {
          markSeen(extension, name, existing.revision);
          return existing.snapshot as VariableSnapshot<T>;
        }
        const time = now();
        const writer: VariableWriter = { extension, window: self.id };
        const revision: VariableRevision = { n: 0, window: self.id };
        const e = put(
          { name, value: frozenCopy(init.initial), revision, writer, registeredBy: writer, description: init.description },
          [],
        );
        record(e, { time, writer, revision, outcome: "accepted" });
        markSeen(extension, name, revision);
        reportLarge(e);
        post({
          type: "write",
          from: self,
          time,
          name,
          value: e.value,
          revision,
          basedOn: null,
          writer,
          registeredBy: writer,
          description: init.description,
        });
        changed();
        deliver(e.snapshot, subscribers.get(name) ?? []);
        return e.snapshot as VariableSnapshot<T>;
      },

      get<T>(name: string): VariableSnapshot<T> | undefined {
        const e = entries.get(name);
        if (!e) return undefined;
        markSeen(extension, name, e.revision);
        return e.snapshot as VariableSnapshot<T>;
      },

      subscribe<T>(name: string, listener: (snapshot: VariableSnapshot<T>) => void): () => void {
        const sub: Subscriber = { extension, listener: listener as Subscriber["listener"] };
        subscribers.set(name, [...(subscribers.get(name) ?? []), sub]);
        changed();
        const e = entries.get(name);
        if (e) deliver(e.snapshot, [sub]);
        return () => {
          const list = subscribers.get(name);
          if (!list?.includes(sub)) return;
          subscribers.set(name, list.filter((s) => s !== sub));
          changed();
        };
      },

      set<T>(name: string, value: T): VariableWriteResult<T> {
        const e = entries.get(name);
        if (!e) return unregistered(extension, name);
        const problem = valueProblem(value);
        if (problem) return invalid(extension, e, problem);
        const saw = seen.get(extension)?.get(name);
        if (!sameRevision(saw, e.revision)) {
          const since = saw ? `since ${extension} last saw it (rev ${saw.n})` : `and ${extension} hasn't read it yet`;
          warn(`[variables] ${name}: write by ${extension} refused — ${who(e.writer)} changed it (rev ${e.revision.n}) ${since}.`);
          refuse(extension, e, "stale");
          return { ok: false, reason: "stale", current: e.snapshot as VariableSnapshot<T> };
        }
        // Reading the value (getters) can run code that writes this variable;
        // accepting then would number two different values with one revision.
        const copy = frozenCopy(value);
        if (entries.get(name) !== e) return invalid(extension, e, `${name} changed while its new value was being read`);
        return { ok: true, revision: accept(extension, e, copy) };
      },

      update<T>(name: string, fn: (current: T) => T): VariableWriteResult<T> {
        const e = entries.get(name);
        if (!e) return unregistered(extension, name);
        let next: unknown;
        try {
          next = fn(e.value as T);
        } catch (err) {
          return invalid(extension, e, `update function threw: ${errorText(err)}`);
        }
        if (isThenable(next))
          return invalid(extension, e, "update function returned a Promise; it must return the new value");
        const problem = valueProblem(next);
        if (problem) return invalid(extension, e, problem);
        const copy = frozenCopy(next);
        // fn ran with the entry captured above; if it wrote this variable, the
        // result is based on a value that no longer exists.
        if (entries.get(name) !== e) return invalid(extension, e, `update function wrote ${name} while it ran`);
        return { ok: true, revision: accept(extension, e, copy) };
      },
    };
    scopes.set(extension, api);
    return api;
  }

  interface IncomingWrite extends EntryFields {
    basedOn: VariableRevision | null;
    time: number;
  }

  // The current value was written here and the incoming write replaces it
  // without having seen it. A basedOn newer than ours means its writer saw a
  // later state, so ours was replaced in order. An equal value or a
  // registration being replaced is no loss worth reporting.
  function lostHere(current: Entry, w: IncomingWrite): boolean {
    if (current.writer.window !== self.id || current.revision.n === 0) return false;
    const sawCurrent =
      w.basedOn !== null && (w.basedOn.n > current.revision.n || sameRevision(w.basedOn, current.revision));
    return !sawCurrent && !jsonEqual(current.value, w.value);
  }

  function applyRemote(w: IncomingWrite, history?: VariableHistoryItem[]): void {
    const current = entries.get(w.name);
    if (current && compareRevisions(w.revision, current.revision) <= 0) return;
    const e = put(
      {
        name: w.name,
        value: frozenCopy(w.value),
        revision: w.revision,
        writer: w.writer,
        registeredBy: w.registeredBy,
        description: w.description,
      },
      history ?? current?.history ?? [],
    );
    if (!history) record(e, { time: w.time, writer: w.writer, revision: w.revision, outcome: "accepted" });
    if (current && lostHere(current, w)) {
      const item: VariableHistoryItem = {
        time: now(),
        writer: current.writer,
        revision: current.revision,
        outcome: "lost",
        other: w.writer,
      };
      record(e, item);
      warn(
        `[variables] ${w.name}: write by ${current.writer.extension} in this window lost to ${who(w.writer)} writing at the same time.`,
      );
      post({ type: "outcome", from: self, name: w.name, item });
    }
    changed();
    deliver(e.snapshot, subscribers.get(w.name) ?? []);
  }

  function receive(m: VariableMessage): void {
    labels.set(m.from.id, m.from.label);
    switch (m.type) {
      case "write":
        applyRemote({
          name: m.name,
          value: m.value,
          revision: m.revision,
          basedOn: m.basedOn,
          writer: m.writer,
          registeredBy: m.registeredBy,
          description: m.description,
          time: m.time,
        });
        return;
      case "outcome": {
        const e = entries.get(m.name);
        if (!e) return;
        record(e, m.item);
        changed();
        return;
      }
      case "hello":
        post({
          type: "answer",
          from: self,
          to: m.from.id,
          entries: [...entries.values()].map((e) => ({
            name: e.name,
            value: e.value,
            revision: e.revision,
            writer: e.writer,
            registeredBy: e.registeredBy,
            description: e.description,
            history: e.history,
          })),
        });
        return;
      case "answer":
        if (m.to !== self.id) return;
        for (const w of m.entries) {
          const current = entries.get(w.name);
          const history = mergeHistories(current?.history ?? [], w.history);
          if (current && compareRevisions(w.revision, current.revision) <= 0) {
            current.history = history;
            continue;
          }
          applyRemote({ ...w, basedOn: null, time: now() }, history);
        }
        changed();
        return;
    }
  }

  const unlisten = transport ? transport.listen(receive) : null;
  post({ type: "hello", from: self });

  return {
    scoped,
    dropExtension(extension: string): void {
      for (const [name, list] of subscribers)
        subscribers.set(name, list.filter((s) => s.extension !== extension));
      seen.delete(extension);
      changed();
    },
    inspect(): VariableInspection[] {
      return [...entries.values()]
        .sort((x, y) => x.name.localeCompare(y.name))
        .map((e) => ({
          snapshot: e.snapshot,
          size: e.size,
          history: [...e.history],
          subscribers: (subscribers.get(e.name) ?? []).map((s) => s.extension),
        }));
    },
    subscribeChanges(listener: () => void): () => void {
      changeListeners.add(listener);
      return () => {
        changeListeners.delete(listener);
      };
    },
    changeCount: () => changes,
    windowName,
    dispose(): void {
      unlisten?.();
      changeListeners.clear();
    },
  };
}
