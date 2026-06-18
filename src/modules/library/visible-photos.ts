// The Library grid shows photos after applying the active filter and sort. The
// same derivation drives keyboard navigation, so culling moves through exactly
// what the eye sees — never a hidden photo.

import type {
  CatalogPhoto,
  ColorLabel,
  SortDirection,
  SortField,
} from "@/catalog/types";

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

function sortValue(p: CatalogPhoto, field: SortField): number | string {
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

// A photo is in scope when it lives in `folder` or any subfolder of it.
function inFolder(p: CatalogPhoto, folder: string): boolean {
  return p.folder === folder || p.folder.startsWith(`${folder}/`) || folder === "";
}

export function visiblePhotos(
  photos: CatalogPhoto[],
  filter: LibraryFilter,
  sortField: SortField,
  sortDir: SortDirection,
  folder: string | null = null,
): CatalogPhoto[] {
  const dir = sortDir === "asc" ? 1 : -1;
  // .filter() already returns a fresh array, so sorting it in place is safe.
  return photos
    .filter((p) => (folder === null || inFolder(p, folder)) && matches(p, filter))
    .sort((a, b) => {
      const av = sortValue(a, sortField);
      const bv = sortValue(b, sortField);
      let c =
        typeof av === "string" && typeof bv === "string"
          ? av.localeCompare(bv)
          : (av as number) - (bv as number);
      if (c === 0) c = a.dateImported - b.dateImported; // stable tiebreak
      return c * dir;
    });
}
