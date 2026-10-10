// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { DevelopParams } from "./types";

interface Edit {
  params: DevelopParams;
  paramBag: Record<string, unknown>;
}

/** True when two edits hold the same look. Plain objects, arrays and typed
 *  arrays compare by content, and a key set to undefined counts as absent, as
 *  it does once the edit is saved. Any other object (a Map, a Date, a class
 *  instance an extension keeps in its bag) matches only itself, so a value this
 *  can't see into never hides a real change. Shared references match without
 *  being walked, which keeps an in-session history entry cheap to compare. */
export function sameEdit(a: Edit, b: Edit): boolean {
  return same(a.params, b.params) && same(a.paramBag, b.paramBag);
}

function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && sameItems(a, b, same);
  }
  if (isTypedArray(a) || isTypedArray(b)) {
    return (
      isTypedArray(a) &&
      isTypedArray(b) &&
      Object.getPrototypeOf(a) === Object.getPrototypeOf(b) &&
      sameItems(a, b, Object.is)
    );
  }
  return isPlainObject(a) && isPlainObject(b) && sameRecord(a, b);
}

function sameItems(
  a: ArrayLike<unknown>,
  b: ArrayLike<unknown>,
  equal: (x: unknown, y: unknown) => boolean,
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!equal(a[i], b[i])) return false;
  }
  return true;
}

function sameRecord(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  let defined = 0;
  for (const key of Object.keys(a)) {
    if (a[key] === undefined) continue;
    if (!Object.hasOwn(b, key) || !same(a[key], b[key])) return false;
    defined++;
  }
  return defined === definedKeyCount(b);
}

function definedKeyCount(record: Record<string, unknown>): number {
  let count = 0;
  for (const key of Object.keys(record)) {
    if (record[key] !== undefined) count++;
  }
  return count;
}

function isTypedArray(value: object): value is ArrayLike<unknown> {
  return ArrayBuffer.isView(value) && !(value instanceof DataView);
}

// An object from another realm fails this and compares as different: the edit commits.
function isPlainObject(value: object): value is Record<string, unknown> {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
