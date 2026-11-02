// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// ---------------------------------------------------------------------------
// Shared variables (api.variables)
// ---------------------------------------------------------------------------

/** Who made a write or a registration. */
export interface VariableWriter {
  /** Extension id; Developer Tools' Edit value writes as its own. */
  extension: string;
  /** The window it happened in. */
  window: string;
}

/** Orders writes across windows: the higher `n` wins, and an equal `n` is
 *  broken by window id, so every window picks the same winner. */
export interface VariableRevision {
  n: number;
  window: string;
}

export interface VariableSnapshot<T> {
  name: string;
  /** Deep-frozen: change it with set() or update(), never in place. */
  value: T;
  revision: VariableRevision;
  writer: VariableWriter;
  registeredBy: VariableWriter;
  description?: string;
}

export type VariableWriteResult<T> =
  | { ok: true; revision: VariableRevision }
  | { ok: false; reason: "stale"; current: VariableSnapshot<T> }
  | { ok: false; reason: "unregistered" }
  | { ok: false; reason: "invalid"; message: string };

/** Named JSON values every extension can share, in every window. Values are
 *  plain JSON data (objects, arrays, strings, finite numbers, booleans, null)
 *  and last for the session. Writes use optimistic locking: an extension's
 *  set() is refused when another writer changed the variable after the latest
 *  revision this extension saw (through register, get, a subscriber delivery,
 *  or its own write). Refusals and lost cross-window races are logged as
 *  `[variables]` warnings, which Developer Tools' Issues tab shows. */
export interface SharedVariablesAPI {
  /** Make `name` exist. Idempotent: the first registration's `initial` and
   *  `description` win; a later call (any extension, any window) joins and
   *  gets the current snapshot. Throws on an invalid or reserved name, or an
   *  `initial` that isn't JSON data, or a `description` that isn't a string. */
  register<T>(name: string, init: { initial: T; description?: string }): VariableSnapshot<T>;
  /** The current snapshot, or undefined when nobody has registered `name`. */
  get<T>(name: string): VariableSnapshot<T> | undefined;
  /** Called with the current snapshot if `name` exists (right away, or right
   *  after a delivery in progress), else on registration; then on every
   *  accepted write, local or from another window, in revision order. Returns
   *  the unsubscribe function. A listener that throws is logged; the others
   *  still run. */
  subscribe<T>(name: string, listener: (snapshot: VariableSnapshot<T>) => void): () => void;
  /** Write `value`. Refused as "stale" when another writer changed the
   *  variable after the latest revision this extension saw in this window. */
  set<T>(name: string, value: T): VariableWriteResult<T>;
  /** Read-modify-write: `fn` runs synchronously on the latest value and its
   *  result is written, so it is never "stale" within a window. A throwing
   *  `fn`, or one that returns a Promise, writes nothing ("invalid"). */
  update<T>(name: string, fn: (current: T) => T): VariableWriteResult<T>;
}
