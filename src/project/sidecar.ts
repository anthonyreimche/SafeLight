// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The <image>.safelight.json sidecar: written by folder-ops.exportPhotoData, read
// by an import. It lets ratings, labels and develop edits ("maps") follow the photo
// into another project folder.

import type { CatalogPhoto, EditState } from "@/catalog/types";

export const SIDECAR_SUFFIX = ".safelight.json";

/** A sidecar travels between machines and versions, so on reading any field may be
 *  missing; exportPhotoData writes them all. */
export interface PhotoSidecar {
  safelightSidecar?: number;
  /** The image's file name when the sidecar was written. */
  filename?: string;
  /** Catalogue metadata the user set (not file-derived fields like EXIF). */
  info?: {
    rating?: number;
    colorLabel?: CatalogPhoto["colorLabel"];
    flag?: CatalogPhoto["flag"];
    keywords?: string[];
  };
  /** Develop edit history (its snapshots carry the masks = "maps"). */
  maps?: { stack: EditState["stack"]; currentIndex: number } | null;
}

const COLOR_LABELS: readonly CatalogPhoto["colorLabel"][] = [
  "none",
  "red",
  "yellow",
  "green",
  "blue",
  "purple",
];
const FLAGS: readonly CatalogPhoto["flag"][] = ["none", "pick", "reject"];

/** The fields of a sidecar's info a photo can hold. A sidecar travels between
 *  machines and versions, so each value is checked rather than trusted. */
export function adoptSidecar(
  info: NonNullable<PhotoSidecar["info"]>,
): Partial<Pick<CatalogPhoto, "rating" | "colorLabel" | "flag" | "keywords">> {
  const adopted: ReturnType<typeof adoptSidecar> = {};
  const { rating, colorLabel, flag, keywords } = info;
  if (typeof rating === "number" && Number.isInteger(rating) && rating >= 0 && rating <= 5)
    adopted.rating = rating;
  if (colorLabel && COLOR_LABELS.includes(colorLabel)) adopted.colorLabel = colorLabel;
  if (flag && FLAGS.includes(flag)) adopted.flag = flag;
  if (Array.isArray(keywords))
    adopted.keywords = keywords.filter((k): k is string => typeof k === "string" && k !== "");
  return adopted;
}
