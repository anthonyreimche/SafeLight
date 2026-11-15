// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// An edit history as catalog.json stores it, the way git packs objects: a step
// stored whole every BASE_EVERY steps, and each step between as the changes from
// the step before it. In memory every step stays whole, so nothing but the
// catalogue's reader and writer ever sees a packed one.
//
// A step's changes are a list of operations, each on the value at a path of keys
// and array indices, leaving out the step's timestamp and label, which it keeps
// as they are:
//
//   [path, value]                  set the value at path
//   [path]                         remove the key at path
//   [path, at, removed, items]     splice the array at path
//
// A slider move is then one value, and a brush stroke the dabs it added. A step
// that can't be unpacked (the step before it can't, or its changes don't fit
// that step) comes back as null, which the catalogue's reader leaves out, so
// damage reaches no further than the next step stored whole.

/** How often a step is stored whole: the most steps a damaged one can take with
 *  it, and the most changes an open applies to unpack one. */
export const BASE_EVERY = 20;

type Fields = Record<string, unknown>;
type Path = (string | number)[];
export type DeltaOp = [Path] | [Path, unknown] | [Path, number, number, unknown[]];

/** A step stored as its changes from the step before it. */
export interface DeltaStep {
  timestamp?: unknown;
  label?: unknown;
  delta: DeltaOp[];
}

const isFields = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A step is a delta when it has changes and no params, which every step stored
 *  whole leaves out or holds as an object. */
const isDeltaStep = (value: unknown): value is DeltaStep =>
  isFields(value) && Array.isArray(value.delta) && !("params" in value);

/** The keys JSON writes: a key holding undefined is left out. */
const keysOf = (fields: Fields) => Object.keys(fields).filter((key) => fields[key] !== undefined);

/** Equal as JSON stores them (0 and -0 alike, NaN as itself). */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (!isFields(a) || !isFields(b)) return false;
  const keys = keysOf(a);
  return keys.length === keysOf(b).length && keys.every((key) => b[key] !== undefined && same(a[key], b[key]));
}

function contentOf(step: Fields): Fields {
  const content = { ...step };
  delete content.timestamp;
  delete content.label;
  return content;
}

function diffInto(ops: DeltaOp[], path: Path, a: unknown, b: unknown): void {
  if (same(a, b)) return;
  if (isFields(a) && isFields(b)) {
    for (const key of keysOf(b)) {
      if (a[key] === undefined) ops.push([[...path, key], b[key]]);
      else diffInto(ops, [...path, key], a[key], b[key]);
    }
    for (const key of keysOf(a)) if (b[key] === undefined) ops.push([[...path, key]]);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length === b.length) {
      for (let i = 0; i < a.length; i++) diffInto(ops, [...path, i], a[i], b[i]);
      return;
    }
    let start = 0;
    while (start < a.length && start < b.length && same(a[start], b[start])) start++;
    let end = 0;
    while (end < a.length - start && end < b.length - start && same(a[a.length - 1 - end], b[b.length - 1 - end])) end++;
    ops.push([path, start, a.length - start - end, b.slice(start, b.length - end)]);
    return;
  }
  ops.push([path, b]);
}

/** `step` as the changes from `prev`. */
export function deltaStep(prev: Fields, step: Fields): DeltaStep {
  const delta: DeltaOp[] = [];
  diffInto(delta, [], contentOf(prev), contentOf(step));
  return { timestamp: step.timestamp, label: step.label, delta };
}

/** Whether step `index` of a stack is a base, stored whole whatever comes before it. */
export const isBaseIndex = (index: number): boolean => index % BASE_EVERY === 0;

/** How step `index` of a stack is stored, given the step before it: whole at a
 *  base and after a step that isn't one, else as its changes. */
export function packStep(prev: unknown, step: Fields, index: number): Fields | DeltaStep {
  return isBaseIndex(index) || !isFields(prev) ? step : deltaStep(prev, step);
}

/** A history as catalog.json stores it. What isn't a step stays as it is. */
export function packStack<T extends object>(stack: readonly T[]): (T | DeltaStep)[] {
  return stack.map((step, i) => (isFields(step) ? (packStep(stack[i - 1], step, i) as T | DeltaStep) : step));
}

const UNFIT = Symbol("unfit");

const isIndex = (key: unknown, length: number): key is number =>
  typeof key === "number" && Number.isInteger(key) && key >= 0 && key < length;

/** `node` with the value at `path` replaced by what `leaf` makes of it, copying
 *  only the objects and arrays on the way; UNFIT when the path isn't there. */
function edited(node: unknown, path: Path, at: number, leaf: (value: unknown) => unknown): unknown {
  if (at === path.length) return leaf(node);
  const key = path[at];
  if (Array.isArray(node) && isIndex(key, node.length)) {
    const child = edited(node[key], path, at + 1, leaf);
    if (child === UNFIT) return UNFIT;
    const copy = node.slice();
    copy[key] = child;
    return copy;
  }
  if (isFields(node) && typeof key === "string" && Object.hasOwn(node, key)) {
    const child = edited(node[key], path, at + 1, leaf);
    return child === UNFIT ? UNFIT : { ...node, [key]: child };
  }
  return UNFIT;
}

const isPath = (value: unknown): value is Path =>
  Array.isArray(value) && value.every((key) => typeof key === "string" || typeof key === "number");

function applied(content: unknown, op: unknown): unknown {
  if (!Array.isArray(op) || !isPath(op[0])) return UNFIT;
  const path = op[0];
  if (op.length === 4) {
    const [, start, removed, items] = op;
    return edited(content, path, 0, (array) =>
      Array.isArray(array) &&
      Array.isArray(items) &&
      Number.isInteger(start) &&
      Number.isInteger(removed) &&
      start >= 0 &&
      removed >= 0 &&
      start + removed <= array.length
        ? [...array.slice(0, start), ...items, ...array.slice(start + removed)]
        : UNFIT,
    );
  }
  if (path.length === 0 || (op.length !== 1 && op.length !== 2)) return UNFIT;
  const key = path[path.length - 1];
  return edited(content, path.slice(0, -1), 0, (parent) => {
    if (op.length === 1) {
      if (!isFields(parent) || typeof key !== "string" || !Object.hasOwn(parent, key)) return UNFIT;
      const rest = { ...parent };
      delete rest[key];
      return rest;
    }
    if (isFields(parent) && typeof key === "string") return { ...parent, [key]: op[1] };
    if (Array.isArray(parent) && isIndex(key, parent.length)) {
      const copy = parent.slice();
      copy[key] = op[1];
      return copy;
    }
    return UNFIT;
  });
}

function unpackStep(prev: Fields, step: DeltaStep): Fields | null {
  let content: unknown = contentOf(prev);
  for (const op of step.delta) {
    content = applied(content, op);
    if (content === UNFIT) return null;
  }
  if (!isFields(content)) return null;
  const head: Fields = {};
  if (step.timestamp !== undefined) head.timestamp = step.timestamp;
  if (step.label !== undefined) head.label = step.label;
  return { ...head, ...content };
}

/** A history as catalog.json stores it, every step whole again: one that can't
 *  be unpacked is null. A history stored whole comes back as it is. */
export function unpackStack(stored: readonly unknown[]): unknown[] {
  const stack: unknown[] = [];
  let prev: unknown = undefined;
  for (const entry of stored) {
    const step = isDeltaStep(entry) ? (isFields(prev) ? unpackStep(prev, entry) : null) : entry;
    stack.push(step);
    prev = step;
  }
  return stack;
}
