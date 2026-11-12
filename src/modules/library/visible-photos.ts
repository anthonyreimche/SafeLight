// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The Library grid shows photos after applying the active filter and sort. The
// same derivation drives keyboard navigation, so culling moves through exactly
// what the eye sees — never a hidden photo.

import type {
  CatalogPhoto,
  ColorLabel,
  SortDirection,
} from "@/catalog/types";
import { getSettings } from "@/state/settings-store";

export type FlagFilter = "any" | "pick" | "reject";
export type LabelFilter = "any" | ColorLabel;
export type RatingOp = "lt" | "lte" | "gt" | "gte" | "eq" | "neq";

export interface LibraryFilter {
  rating: number; // stars threshold, compared via ratingOp
  ratingOp: RatingOp; // how photo.rating is compared to `rating`
  flag: FlagFilter;
  label: LabelFilter;
  keywords: string[]; // photo must contain ALL of these keywords (AND)
}

export const NO_FILTER: LibraryFilter = {
  rating: 0,
  ratingOp: "gte",
  flag: "any",
  label: "any",
  keywords: [],
};

// The rating filter is inert at "≥ 0" (matches everything); any other operator
// or a positive threshold means it's actively filtering.
function ratingFilterActive(f: LibraryFilter): boolean {
  return f.rating > 0 || f.ratingOp !== "gte";
}

function ratingMatches(rating: number, op: RatingOp, threshold: number): boolean {
  if (op === "lt") return rating < threshold;
  if (op === "lte") return rating <= threshold;
  if (op === "gt") return rating > threshold;
  if (op === "gte") return rating >= threshold;
  if (op === "eq") return rating === threshold;
  return rating !== threshold; // neq
}

export function isFilterActive(f: LibraryFilter): boolean {
  return ratingFilterActive(f) || f.flag !== "any" || f.label !== "any" || f.keywords.length > 0;
}

function matches(photo: CatalogPhoto, f: LibraryFilter): boolean {
  if (
    ratingFilterActive(f) &&
    !ratingMatches(photo.rating, f.ratingOp, f.rating)
  )
    return false;
  if (f.flag !== "any" && photo.flag !== f.flag) return false;
  if (f.label !== "any" && photo.colorLabel !== f.label) return false;
  if (f.keywords.length > 0) {
    const lower = photo.keywords.map((k) => k.toLowerCase());
    if (!f.keywords.every((k) => lower.includes(k.toLowerCase()))) return false;
  }
  return true;
}

// `field` is a built-in SortField; unknown ids (e.g. an extension sort handled
// via customCompare) fall through to the dateImported default.
function sortValue(p: CatalogPhoto, field: string): number | string {
  switch (field) {
    case "filename":
      return p.filename.toLowerCase();
    case "rating":
      return p.rating;
    case "dateCreated":
      return p.dateCreated;
    case "dateImported":
    default:
      return p.dateImported;
  }
}

// A photo is in scope when it lives directly in `folder`. Subfolders are
// included only when the showSubfolderPhotos preference is on — including for
// the project root (""), so the root node respects the preference too and only
// the "All Photos" scope (folder === null) ever shows the whole catalogue. Read
// in visibleOrder, not threaded through callers, so the grid, keyboard culling,
// develop navigation and thumbnail prefetch all scope to exactly the same set.
function inFolder(p: CatalogPhoto, folder: string, subfolders: boolean): boolean {
  if (p.folder === folder) return true;
  if (!subfolders) return false;
  // Root ("") is a prefix of every path; guard so "" doesn't match via the
  // empty-string startsWith and to avoid a leading-slash mismatch.
  return folder === "" || p.folder.startsWith(`${folder}/`);
}

/** The photo fields visibleOrder reads for a built-in filter, sort and folder scope
 *  (no extension filter or sort): while none of them changes, nor does the order. */
export function orderFieldsRead(
  filter: LibraryFilter,
  sortField: string,
  folder: string | null,
): (keyof CatalogPhoto)[] {
  const fields: (keyof CatalogPhoto)[] = ["dateImported"]; // the tiebreak
  if (ratingFilterActive(filter)) fields.push("rating");
  if (filter.flag !== "any") fields.push("flag");
  if (filter.label !== "any") fields.push("colorLabel");
  if (filter.keywords.length > 0) fields.push("keywords");
  if (folder !== null) fields.push("folder");
  // Any other sort id sorts by dateImported (see sortValue), listed above.
  if (sortField === "filename" || sortField === "rating" || sortField === "dateCreated") {
    fields.push(sortField);
  }
  return fields;
}

interface Keyed {
  photo: CatalogPhoto;
  /** sortValue of the photo; unused under an extension's comparator. */
  key: number | string;
}

type PhotoCompare = (a: CatalogPhoto, b: CatalogPhoto) => number;

/** The grid's order: the sort's key (or an extension's comparator), then the
 *  import date, in the toolbar's direction. Zero for photos it can't tell apart,
 *  which keep the catalogue's order. */
function orderCompare(sortDir: SortDirection, customCompare: PhotoCompare | undefined) {
  const dir = sortDir === "asc" ? 1 : -1;
  return (a: Keyed, b: Keyed): number => {
    let c: number;
    if (customCompare) {
      c = customCompare(a.photo, b.photo);
    } else {
      c =
        typeof a.key === "string" && typeof b.key === "string"
          ? a.key.localeCompare(b.key)
          : (a.key as number) - (b.key as number);
    }
    if (c === 0) c = a.photo.dateImported - b.photo.dateImported; // stable tiebreak
    return c * dir;
  };
}

/** How many of `shown` come before `photo` in the order visibleOrder gives
 *  `photos` with no filter: where a photo the filter has dropped would sit among
 *  the ones still shown (the grid's list, in any order). One pass over `shown`,
 *  in place of sorting `photos` to find out. -1 when the folder scope leaves
 *  `photo` out. */
export function placeAmongShown(
  photos: CatalogPhoto[],
  photo: CatalogPhoto,
  shown: readonly CatalogPhoto[],
  sortField: string,
  sortDir: SortDirection,
  folder: string | null,
  customCompare?: PhotoCompare,
): number {
  if (folder !== null && !inFolder(photo, folder, getSettings().showSubfolderPhotos)) return -1;
  const compare = orderCompare(sortDir, customCompare);
  const keyed = (p: CatalogPhoto): Keyed => ({
    photo: p,
    key: customCompare ? 0 : sortValue(p, sortField),
  });
  const target = keyed(photo);
  // Only photos the sort can't tell apart need their place in the catalogue.
  let places: Map<CatalogPhoto, number> | undefined;
  const placeOf = (p: CatalogPhoto): number => {
    places ??= new Map(photos.map((q, i) => [q, i]));
    return places.get(p) ?? -1;
  };
  let before = 0;
  for (const p of shown) {
    const c = compare(keyed(p), target);
    if (c < 0 || (c === 0 && placeOf(p) < placeOf(photo))) before++;
  }
  return before;
}

/** visiblePhotos as indices into `photos`: the photos the grid shows, in order. */
export function visibleOrder(
  photos: CatalogPhoto[],
  filter: LibraryFilter,
  // A built-in SortField or an extension sort id (resolved via customCompare).
  sortField: string,
  sortDir: SortDirection,
  folder: string | null = null,
  // Extra predicates (e.g. an extension's text/EXIF search). ANDed with the
  // built-in filter so culling walks exactly what the grid shows.
  predicates: readonly ((p: CatalogPhoto) => boolean)[] = [],
  // Ascending comparator for an extension-contributed sort; when given it
  // replaces the built-in field comparator (direction + tiebreak still apply).
  customCompare?: PhotoCompare,
): number[] {
  const subfolders = folder !== null && getSettings().showSubfolderPhotos;
  const shown: (Keyed & { index: number })[] = [];
  photos.forEach((p, index) => {
    if (
      (folder === null || inFolder(p, folder, subfolders)) &&
      matches(p, filter) &&
      predicates.every((fn) => fn(p))
    ) {
      shown.push({ index, photo: p, key: customCompare ? 0 : sortValue(p, sortField) });
    }
  });
  // Keys are computed once per photo, not once per comparison.
  shown.sort(orderCompare(sortDir, customCompare));
  return shown.map((s) => s.index);
}

export function visiblePhotos(
  photos: CatalogPhoto[],
  filter: LibraryFilter,
  sortField: string,
  sortDir: SortDirection,
  folder: string | null = null,
  predicates: ((p: CatalogPhoto) => boolean)[] = [],
  customCompare?: (a: CatalogPhoto, b: CatalogPhoto) => number,
): CatalogPhoto[] {
  return visibleOrder(photos, filter, sortField, sortDir, folder, predicates, customCompare).map(
    (i) => photos[i],
  );
}
