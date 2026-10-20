// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Checks and copies for shared-variable names and values (see variables.ts).
// Values are JSON data so the copy another window receives is exact, deep
// freezing is safe (typed arrays can't be frozen), the size estimate is cheap,
// and Developer Tools can show any value as JSON.

export const MAX_NAME_LENGTH = 128;
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;

/** Why `name` can't name a variable, or null when it can. */
export function nameProblem(name: string): string | null {
  if (typeof name !== "string" || name.length > MAX_NAME_LENGTH || !NAME_RE.test(name))
    return `invalid variable name ${JSON.stringify(name)}`;
  if (name === "core" || name.startsWith("core."))
    return `variable name ${JSON.stringify(name)} is reserved for core`;
  return null;
}

/** Where `value` stops being JSON data, e.g. "value.track.segments[0][3].t: NaN",
 *  or null when it is. An undefined object property is allowed: the copy drops
 *  it, as JSON does. */
export function valueProblem(value: unknown, path = "value"): string | null {
  return check(value, path, new Set());
}

const keyPath = (key: string) => (IDENTIFIER_RE.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`);

function check(v: unknown, path: string, open: Set<object>): string | null {
  if (v === null) return null;
  switch (typeof v) {
    case "string":
    case "boolean":
      return null;
    case "number":
      return Number.isFinite(v) ? null : `${path}: ${String(v)}`;
    case "undefined":
    case "function":
    case "symbol":
    case "bigint":
      return `${path}: ${typeof v}`;
  }
  const o = v as object;
  if (open.has(o)) return `${path}: circular reference`;
  if (ArrayBuffer.isView(o) || o instanceof ArrayBuffer) return `${path}: binary data`;
  if (!Array.isArray(o)) {
    const proto: unknown = Object.getPrototypeOf(o);
    if (proto !== Object.prototype && proto !== null) {
      const ctor = (proto as { constructor?: { name?: string } }).constructor?.name;
      return `${path}: ${ctor || "object"} instance`;
    }
  }
  open.add(o);
  try {
    if (Array.isArray(o)) {
      for (let i = 0; i < o.length; i++) {
        if (!(i in o)) return `${path}[${i}]: empty slot`;
        const p = check(o[i], `${path}[${i}]`, open);
        if (p) return p;
      }
      return null;
    }
    for (const [k, x] of Object.entries(o)) {
      if (x === undefined) continue;
      const p = check(x, `${path}${keyPath(k)}`, open);
      if (p) return p;
    }
    return null;
  } finally {
    open.delete(o);
  }
}

/** A deep copy of a JSON value with every object and array frozen, so neither
 *  the writer nor a reader can change the stored value in place. */
export function frozenCopy<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return Object.freeze(value.map((x: unknown) => frozenCopy(x))) as T;
  // fromEntries makes each key an own data property; a plain assignment would
  // run the prototype setter for a JSON key named "__proto__".
  const entries = Object.entries(value)
    .filter(([, x]) => x !== undefined)
    .map(([k, x]) => [k, frozenCopy(x)] as const);
  return Object.freeze(Object.fromEntries(entries)) as T;
}

/** Structural equality of two JSON values (frozen copies, so no undefined properties). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => jsonEqual(x, b[i]));
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const ka = Object.keys(ra);
  if (ka.length !== Object.keys(rb).length) return false;
  return ka.every((k) => Object.hasOwn(rb, k) && jsonEqual(ra[k], rb[k]));
}

/** Rough in-memory size of a JSON value in bytes: 2 per string character
 *  (keys included), 8 per number, boolean or null. */
export function estimateSize(value: unknown): number {
  if (typeof value === "string") return value.length * 2;
  if (value === null || typeof value !== "object") return 8;
  let n = 0;
  if (Array.isArray(value)) {
    for (const x of value) n += estimateSize(x);
    return n;
  }
  for (const [k, x] of Object.entries(value)) n += k.length * 2 + estimateSize(x);
  return n;
}
