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
// the "All Photos" scope (folder === null) ever shows the whole catalog. Read
// here, not threaded through callers, so the grid, keyboard culling, develop
// navigation and thumbnail prefetch all scope to exactly the same set.
function inFolder(p: CatalogPhoto, folder: string): boolean {
  if (p.folder === folder) return true;
  if (!getSettings().showSubfolderPhotos) return false;
  // Root ("") is a prefix of every path; guard so "" doesn't match via the
  // empty-string startsWith and to avoid a leading-slash mismatch.
  return folder === "" || p.folder.startsWith(`${folder}/`);
}

export function visiblePhotos(
  photos: CatalogPhoto[],
  filter: LibraryFilter,
  // A built-in SortField or an extension sort id (resolved via customCompare).
  sortField: string,
  sortDir: SortDirection,
  folder: string | null = null,
  // Extra predicates (e.g. an extension's text/EXIF search). ANDed with the
  // built-in filter so culling walks exactly what the grid shows.
  predicates: ((p: CatalogPhoto) => boolean)[] = [],
  // Ascending comparator for an extension-contributed sort; when given it
  // replaces the built-in field comparator (direction + tiebreak still apply).
  customCompare?: (a: CatalogPhoto, b: CatalogPhoto) => number,
): CatalogPhoto[] {
  const dir = sortDir === "asc" ? 1 : -1;
  // .filter() already returns a fresh array, so sorting it in place is safe.
  return photos
    .filter(
      (p) =>
        (folder === null || inFolder(p, folder)) &&
        matches(p, filter) &&
        predicates.every((fn) => fn(p)),
    )
    .sort((a, b) => {
      let c: number;
      if (customCompare) {
        c = customCompare(a, b);
      } else {
        const av = sortValue(a, sortField);
        const bv = sortValue(b, sortField);
        c =
          typeof av === "string" && typeof bv === "string"
            ? av.localeCompare(bv)
            : (av as number) - (bv as number);
      }
      if (c === 0) c = a.dateImported - b.dateImported; // stable tiebreak
      return c * dir;
    });
}
