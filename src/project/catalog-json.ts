// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// catalog.json's text, written the way JSON.stringify writes the catalogue with
// each edit history packed (catalog/history-pack.ts), from the text each photo
// record, history step and change stamp had when it was last written. A save after
// one edit writes the one record or step that changed instead of the whole
// catalogue.
//
// The text is kept per object, so it relies on what the storage holds being
// replaced on a change, never changed in place: records, history steps and
// stamps all are. A step stored as its changes is written again when the step
// before it is another object.

import { storedPhoto, type CatalogPhoto, type StoredPhoto } from "@/catalog/types";
import { deltaStep, isBaseIndex } from "@/catalog/history-pack";
import type { CatalogFile } from "./catalog-file";

/** A catalogue to write: its photos as the storage holds them, whose handles and
 *  preview the text leaves out (storedPhoto). */
export type CatalogData = Omit<CatalogFile, "photos"> & {
  photos: readonly (CatalogPhoto | StoredPhoto)[];
};

type Fields = Record<string, unknown>;

const photoTexts = new WeakMap<object, string>();
const stepTexts = new WeakMap<object, string>();
const deltaTexts = new WeakMap<object, { prev: object; text: string }>();
const stampTexts = new WeakMap<object, string>();

/** JSON.stringify, which writes nothing (undefined) for a value JSON leaves out. */
function json(value: unknown): string | undefined {
  return JSON.stringify(value) as string | undefined;
}

/** `value` as JSON.stringify serializes it under `key`: through its toJSON, if any. */
function serialized(key: string, value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const toJSON: unknown = (value as Fields).toJSON;
  return typeof toJSON === "function" ? (toJSON as (key: string) => unknown).call(value, key) : value;
}

function isFields(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function remembered(texts: WeakMap<object, string>, value: object, write: () => string): string {
  let text = texts.get(value);
  if (text === undefined) {
    text = write();
    texts.set(value, text);
  }
  return text;
}

/** An object's text, its own keys in order, each value written by `field`; a value
 *  JSON leaves out leaves its key out. */
function objectText(object: Fields, field: (key: string, value: unknown) => string | undefined): string {
  const parts: string[] = [];
  for (const key of Object.keys(object)) {
    const text = field(key, serialized(key, object[key]));
    if (text !== undefined) parts.push(`${JSON.stringify(key)}:${text}`);
  }
  return `{${parts.join(",")}}`;
}

/** An array's text, each object in it written by `item`; what JSON can't write is null. */
function arrayText(items: readonly unknown[], item: (value: Fields) => string): string {
  const parts: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const value = serialized(String(i), items[i]);
    parts.push(isFields(value) ? item(value) : (json(value) ?? "null"));
  }
  return `[${parts.join(",")}]`;
}

/** Records are written without their handles and preview, as storedPhoto keeps them. */
function photoText(record: Fields): string {
  return remembered(photoTexts, record, () => JSON.stringify(storedPhoto(record as unknown as CatalogPhoto)));
}

/** A history's text, packed as history-pack's packStep packs it: each step whole
 *  or as its changes from the one before, each written once for as long as it and that step stay. */
function stackText(stack: readonly unknown[]): string {
  const parts: string[] = [];
  let prev: unknown = undefined;
  for (let i = 0; i < stack.length; i++) {
    const step = serialized(String(i), stack[i]);
    if (!isFields(step)) parts.push(json(step) ?? "null");
    else if (isBaseIndex(i) || !isFields(prev)) parts.push(remembered(stepTexts, step, () => JSON.stringify(step)));
    else parts.push(deltaText(prev, step));
    prev = step;
  }
  return `[${parts.join(",")}]`;
}

function deltaText(prev: Fields, step: Fields): string {
  const held = deltaTexts.get(step);
  if (held?.prev === prev) return held.text;
  const text = JSON.stringify(deltaStep(prev, step));
  deltaTexts.set(step, { prev, text });
  return text;
}

function editText(edit: Fields): string {
  return objectText(edit, (key, value) => (key === "stack" && Array.isArray(value) ? stackText(value) : json(value)));
}

function stampsText(stamps: Fields): string {
  return objectText(stamps, (_, stamp) =>
    typeof stamp === "object" && stamp !== null
      ? remembered(stampTexts, stamp, () => JSON.stringify(stamp))
      : json(stamp),
  );
}

function changedText(changed: Fields): string {
  return objectText(changed, (key, value) =>
    (key === "photos" || key === "edits") && isFields(value) ? stampsText(value) : json(value),
  );
}

/** The text JSON.stringify writes for `data`, with each photo as storedPhoto keeps it. */
export function catalogText(data: CatalogData): string {
  return objectText(data as unknown as Fields, (key, value) => {
    if (key === "photos" && Array.isArray(value)) return arrayText(value, photoText);
    if (key === "edits" && Array.isArray(value)) return arrayText(value, editText);
    if (key === "changed" && isFields(value)) return changedText(value);
    return json(value);
  });
}

/** Drops the text kept for these steps: a caller may hand back a step it changed
 *  in place (an extension holds the same objects), so a step put again is written
 *  anew. Costs one photo's history per put, not the catalogue's. */
export function forgetStepTexts(stack: readonly object[]): void {
  for (const step of stack) {
    stepTexts.delete(step);
    deltaTexts.delete(step);
  }
}

/** `to` was made from the held record `from` with only its handles or preview
 *  changed: it is written as `from` was. */
export function sameRecordText(from: CatalogPhoto, to: CatalogPhoto): void {
  const text = photoTexts.get(from);
  if (text !== undefined) photoTexts.set(to, text);
}
