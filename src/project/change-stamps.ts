// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Change stamps: which of two versions of a catalog record is newer, whatever
// order they reach a window in. Each window's ProjectStorage stamps the changes it
// makes and keeps the stamps beside its records (never in them); catalog.json and
// the catalog-records messages carry them as one `changed` block. A photo record
// is stamped per group of fields that change together, so changes to different
// groups made in two windows both survive; an edit history is stamped whole, as a
// history can't be merged. A record or group without a stamp is the oldest.

import type { StoredPhoto } from "@/catalog/types";
import { isPlainObject } from "./fs";

/** When a change was made, by the clock of the storage that made it, and that
 *  storage's origin, which orders two changes stamped at the same time. */
export type ChangeStamp = [at: number, by: string];

export type PhotoGroup =
  | "location"
  | "shape"
  | "file"
  | "rating"
  | "colorLabel"
  | "flag"
  | "keywords"
  | "decodeError"
  | "copyName"
  | "created";

/** The fields of a photo record a stamp covers: all but its id and the
 *  description of its stored preview (previewEdit, previewRotation), which follows
 *  the preview instead. */
type StampedField = Exclude<keyof StoredPhoto, "id" | "previewEdit" | "previewRotation">;

/** The group of each stamped field: fields one change always writes together
 *  share a group, so a merge never takes half of such a change. A move or rename
 *  writes the location; a turn swaps width and height; a reimport rewrites the
 *  file's facts; copyOf and dateImported are set as the record is made. */
const GROUP_OF: Record<StampedField, PhotoGroup> = {
  filename: "location",
  relPath: "location",
  folder: "location",
  rotation: "shape",
  width: "shape",
  height: "shape",
  fileSize: "file",
  mimeType: "file",
  dateCreated: "file",
  exif: "file",
  rating: "rating",
  colorLabel: "colorLabel",
  flag: "flag",
  keywords: "keywords",
  decodeError: "decodeError",
  copyName: "copyName",
  copyOf: "created",
  dateImported: "created",
};

const STAMPED_FIELDS = Object.keys(GROUP_OF) as StampedField[];
const PHOTO_GROUPS = [...new Set(Object.values(GROUP_OF))];

/** A photo record's stamps, by group. */
export type PhotoStamps = Partial<Record<PhotoGroup, ChangeStamp>>;

/** The stamps of some records, as catalog.json and catalog-records carry them. */
export interface ChangeStamps {
  photos: Record<string, PhotoStamps>;
  edits: Record<string, ChangeStamp>;
}

/** Whether `a` is a later change than `b`. A missing stamp is never newer, and any
 *  stamp is newer than none; an equal stamp is the same change. */
export function newer(a: ChangeStamp | undefined, b: ChangeStamp | undefined): boolean {
  if (!a) return false;
  if (!b) return true;
  return a[0] !== b[0] ? a[0] > b[0] : a[1] > b[1];
}

/** One storage's clock: the time, but always past every stamp the storage made
 *  or has read, so a change made after another window's is newer than it, within
 *  one millisecond too and whatever the system clock does meanwhile. */
export class ChangeClock {
  private last = 0;
  private readonly by: string;

  constructor(by: string) {
    this.by = by;
  }

  next(): ChangeStamp {
    this.last = Math.max(Date.now(), this.last + 1);
    return [this.last, this.by];
  }

  observe(stamp: ChangeStamp | undefined): void {
    if (stamp && stamp[0] > this.last) this.last = stamp[0];
  }
}

/** Equal as JSON holds them: arrays and plain objects by content, and a missing
 *  field the same as an undefined one. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (!sameValue(a[key], b[key])) return false;
  return true;
}

/** The groups whose fields differ between two versions of a record. */
export function changedGroups(before: StoredPhoto, after: StoredPhoto): PhotoGroup[] {
  const groups = new Set<PhotoGroup>();
  for (const field of STAMPED_FIELDS)
    if (!sameValue(before[field], after[field])) groups.add(GROUP_OF[field]);
  return [...groups];
}

function take<K extends StampedField>(to: StoredPhoto, from: StoredPhoto, field: K): void {
  to[field] = from[field];
}

/** `held` with each group of fields `incoming` holds a newer stamp for, and the
 *  stamps that go with the result. `taken` says whether any group was taken. */
export function mergePhoto(
  held: StoredPhoto,
  heldStamps: PhotoStamps | undefined,
  incoming: StoredPhoto,
  incomingStamps: PhotoStamps | undefined,
): { record: StoredPhoto; stamps: PhotoStamps; taken: boolean } {
  const record: StoredPhoto = { ...held };
  const stamps: PhotoStamps = { ...heldStamps };
  const won = PHOTO_GROUPS.filter((group) => newer(incomingStamps?.[group], heldStamps?.[group]));
  for (const group of won) stamps[group] = incomingStamps?.[group];
  for (const field of STAMPED_FIELDS) if (won.includes(GROUP_OF[field])) take(record, incoming, field);
  return { record, stamps, taken: won.length > 0 };
}

/** Every group of a record, each stamped `stamp`: a record made by this change. */
export function stampAll(stamp: ChangeStamp): PhotoStamps {
  const stamps: PhotoStamps = {};
  for (const group of PHOTO_GROUPS) stamps[group] = stamp;
  return stamps;
}

/** The groups' newest stamp, for the clock to move past. */
export function latest(stamps: PhotoStamps | undefined): ChangeStamp | undefined {
  let last: ChangeStamp | undefined;
  for (const group of PHOTO_GROUPS) if (newer(stamps?.[group], last)) last = stamps?.[group];
  return last;
}

function isStamp(value: unknown): value is ChangeStamp {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "number" &&
    Number.isFinite(value[0]) &&
    typeof value[1] === "string"
  );
}

/** The stamps a catalog.json `changed` block holds that this build can read. One it
 *  can't is left out: its record only counts as the oldest. */
export function readChangeStamps(value: unknown): ChangeStamps {
  const block = isPlainObject(value) ? value : {};
  const photos = isPlainObject(block.photos) ? Object.entries(block.photos) : [];
  const edits = isPlainObject(block.edits) ? Object.entries(block.edits) : [];
  return {
    photos: Object.fromEntries(
      photos.flatMap(([id, groups]) => {
        if (!isPlainObject(groups)) return [];
        const kept: PhotoStamps = {};
        for (const group of PHOTO_GROUPS) {
          const stamp = groups[group];
          if (isStamp(stamp)) kept[group] = stamp;
        }
        return Object.keys(kept).length > 0 ? [[id, kept] as const] : [];
      }),
    ),
    edits: Object.fromEntries(
      edits.flatMap(([id, stamp]) => (isStamp(stamp) ? [[id, stamp] as const] : [])),
    ),
  };
}

/** `record[id]` if `record` has its own entry for it. */
export function own<T>(record: Record<string, T> | undefined, id: string): T | undefined {
  return record && Object.hasOwn(record, id) ? record[id] : undefined;
}
