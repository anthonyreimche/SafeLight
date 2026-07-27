// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, it, expect, vi, beforeEach } from "vitest";

// visiblePhotos reads the subfolder preference itself (so the grid, culling and
// develop navigation can't disagree); the mock lets each test drive it.
const h = vi.hoisted(() => ({ settings: { showSubfolderPhotos: false } }));
vi.mock("@/state/settings-store", () => ({ getSettings: () => h.settings }));

import {
  isFilterActive,
  NO_FILTER,
  visiblePhotos,
  type LibraryFilter,
} from "./visible-photos";
import type { CatalogPhoto } from "@/catalog/types";

function photo(over: Partial<CatalogPhoto> & { id: string }): CatalogPhoto {
  return {
    filename: `${over.id}.NEF`,
    relPath: over.id,
    folder: "",
    directoryHandle: null,
    fileHandle: null,
    thumbnailBlob: null,
    thumbnailUrl: null,
    width: 6000,
    height: 4000,
    fileSize: 1000,
    mimeType: "image/x-nikon-nef",
    rating: 0,
    colorLabel: "none",
    flag: "none",
    rotation: 0,
    keywords: [],
    dateCreated: 0,
    dateImported: 0,
    exif: {},
    ...over,
  };
}

const filter = (over: Partial<LibraryFilter> = {}): LibraryFilter => ({
  ...NO_FILTER,
  ...over,
});

const ids = (photos: CatalogPhoto[]) => photos.map((p) => p.id);

beforeEach(() => {
  h.settings.showSubfolderPhotos = false;
});

describe("isFilterActive", () => {
  it("is inert at the default '≥ 0 stars'", () => {
    expect(isFilterActive(NO_FILTER)).toBe(false);
  });

  it("counts a non-gte operator as active even at threshold 0", () => {
    // "= 0 stars" (show only unrated) is a real filter, unlike "≥ 0 stars".
    expect(isFilterActive(filter({ ratingOp: "eq" }))).toBe(true);
    expect(isFilterActive(filter({ ratingOp: "gte", rating: 1 }))).toBe(true);
  });

  it("counts flag, label and keyword criteria", () => {
    expect(isFilterActive(filter({ flag: "pick" }))).toBe(true);
    expect(isFilterActive(filter({ label: "red" }))).toBe(true);
    expect(isFilterActive(filter({ keywords: ["sky"] }))).toBe(true);
  });
});

describe("filtering", () => {
  const rated = [
    photo({ id: "r0", rating: 0 }),
    photo({ id: "r2", rating: 2 }),
    photo({ id: "r5", rating: 5 }),
  ];

  it("passes everything through at '≥ 0 stars'", () => {
    expect(ids(visiblePhotos(rated, NO_FILTER, "dateImported", "asc"))).toEqual([
      "r0",
      "r2",
      "r5",
    ]);
  });

  it("compares the rating with each operator", () => {
    const keep = (over: Partial<LibraryFilter>) =>
      ids(visiblePhotos(rated, filter(over), "rating", "asc"));
    expect(keep({ ratingOp: "gte", rating: 2 })).toEqual(["r2", "r5"]);
    expect(keep({ ratingOp: "gt", rating: 2 })).toEqual(["r5"]);
    expect(keep({ ratingOp: "lte", rating: 2 })).toEqual(["r0", "r2"]);
    expect(keep({ ratingOp: "lt", rating: 2 })).toEqual(["r0"]);
    expect(keep({ ratingOp: "eq", rating: 2 })).toEqual(["r2"]);
    expect(keep({ ratingOp: "neq", rating: 2 })).toEqual(["r0", "r5"]);
  });

  it("selects only unrated photos with '= 0 stars'", () => {
    expect(
      ids(visiblePhotos(rated, filter({ ratingOp: "eq", rating: 0 }), "rating", "asc")),
    ).toEqual(["r0"]);
  });

  it("filters by flag and by colour label", () => {
    const photos = [
      photo({ id: "p", flag: "pick", colorLabel: "red" }),
      photo({ id: "r", flag: "reject", colorLabel: "green" }),
      photo({ id: "n" }),
    ];
    expect(ids(visiblePhotos(photos, filter({ flag: "pick" }), "filename", "asc"))).toEqual(["p"]);
    expect(ids(visiblePhotos(photos, filter({ flag: "reject" }), "filename", "asc"))).toEqual(["r"]);
    expect(ids(visiblePhotos(photos, filter({ label: "green" }), "filename", "asc"))).toEqual(["r"]);
    expect(ids(visiblePhotos(photos, filter({ label: "none" }), "filename", "asc"))).toEqual(["n"]);
  });

  it("requires ALL keywords, case-insensitively on both sides", () => {
    const photos = [
      photo({ id: "both", keywords: ["Sky", "Sunset"] }),
      photo({ id: "one", keywords: ["sky"] }),
      photo({ id: "none" }),
    ];
    expect(
      ids(visiblePhotos(photos, filter({ keywords: ["SKY", "sunset"] }), "filename", "asc")),
    ).toEqual(["both"]);
    expect(
      ids(visiblePhotos(photos, filter({ keywords: ["sky"] }), "filename", "asc")),
    ).toEqual(["both", "one"]);
  });

  it("ANDs extra predicates with the built-in filter", () => {
    const photos = [
      photo({ id: "a", rating: 3, fileSize: 10 }),
      photo({ id: "b", rating: 3, fileSize: 99 }),
      photo({ id: "c", rating: 1, fileSize: 99 }),
    ];
    const big = (p: CatalogPhoto) => p.fileSize > 50;
    const result = visiblePhotos(
      photos,
      filter({ rating: 2 }),
      "filename",
      "asc",
      null,
      [big],
    );
    expect(ids(result)).toEqual(["b"]);
  });

  it("requires every predicate to pass", () => {
    const photos = [photo({ id: "a" }), photo({ id: "b" })];
    const result = visiblePhotos(photos, NO_FILTER, "filename", "asc", null, [
      (p) => p.id !== "a",
      (p) => p.id !== "b",
    ]);
    expect(result).toEqual([]);
  });
});

describe("folder scoping", () => {
  const photos = [
    photo({ id: "root", folder: "" }),
    photo({ id: "trip", folder: "trip" }),
    photo({ id: "day1", folder: "trip/day1" }),
    photo({ id: "deep", folder: "trip/day1/raw" }),
    photo({ id: "sibling", folder: "trip-2" }),
  ];
  const scoped = (folder: string | null) =>
    ids(visiblePhotos(photos, NO_FILTER, "filename", "asc", folder));

  it("shows the whole catalog for the All Photos scope, whatever the preference", () => {
    expect(scoped(null)).toHaveLength(photos.length);
    h.settings.showSubfolderPhotos = true;
    expect(scoped(null)).toHaveLength(photos.length);
  });

  it("shows only direct children while the subfolder preference is off", () => {
    expect(scoped("trip")).toEqual(["trip"]);
    expect(scoped("")).toEqual(["root"]);
  });

  it("includes descendants at any depth once the preference is on", () => {
    h.settings.showSubfolderPhotos = true;
    expect(scoped("trip")).toEqual(["day1", "deep", "trip"]);
  });

  it("never leaks a sibling folder that merely shares a name prefix", () => {
    h.settings.showSubfolderPhotos = true;
    expect(scoped("trip")).not.toContain("sibling");
  });

  it("lets the project root honour the preference too", () => {
    // "" is a prefix of every path, so the root node is special-cased: it only
    // widens to the whole catalog when the user asked for subfolders.
    h.settings.showSubfolderPhotos = true;
    expect(scoped("")).toHaveLength(photos.length);
  });
});

describe("sorting", () => {
  it("sorts filenames case-insensitively", () => {
    const photos = [
      photo({ id: "b", filename: "banana.jpg" }),
      photo({ id: "a", filename: "Apple.jpg" }),
      photo({ id: "c", filename: "cherry.jpg" }),
    ];
    expect(ids(visiblePhotos(photos, NO_FILTER, "filename", "asc"))).toEqual(["a", "b", "c"]);
    expect(ids(visiblePhotos(photos, NO_FILTER, "filename", "desc"))).toEqual(["c", "b", "a"]);
  });

  it("sorts by the numeric fields", () => {
    const photos = [
      photo({ id: "mid", rating: 3, dateCreated: 200, dateImported: 20 }),
      photo({ id: "low", rating: 1, dateCreated: 300, dateImported: 30 }),
      photo({ id: "high", rating: 5, dateCreated: 100, dateImported: 10 }),
    ];
    expect(ids(visiblePhotos(photos, NO_FILTER, "rating", "asc"))).toEqual(["low", "mid", "high"]);
    expect(ids(visiblePhotos(photos, NO_FILTER, "dateCreated", "asc"))).toEqual([
      "high",
      "mid",
      "low",
    ]);
    expect(ids(visiblePhotos(photos, NO_FILTER, "dateImported", "asc"))).toEqual([
      "high",
      "mid",
      "low",
    ]);
  });

  it("falls back to dateImported for an unrecognised sort id", () => {
    const photos = [
      photo({ id: "second", dateImported: 20 }),
      photo({ id: "first", dateImported: 10 }),
    ];
    expect(ids(visiblePhotos(photos, NO_FILTER, "ext.someSort", "asc"))).toEqual([
      "first",
      "second",
    ]);
  });

  it("breaks ties on dateImported, following the sort direction", () => {
    const photos = [
      photo({ id: "late", rating: 3, dateImported: 30 }),
      photo({ id: "early", rating: 3, dateImported: 10 }),
    ];
    expect(ids(visiblePhotos(photos, NO_FILTER, "rating", "asc"))).toEqual(["early", "late"]);
    expect(ids(visiblePhotos(photos, NO_FILTER, "rating", "desc"))).toEqual(["late", "early"]);
  });

  it("uses a custom comparator instead of the field, keeping direction and tiebreak", () => {
    const photos = [
      photo({ id: "a", filename: "a.jpg", fileSize: 30, dateImported: 1 }),
      photo({ id: "b", filename: "b.jpg", fileSize: 10, dateImported: 2 }),
      photo({ id: "c", filename: "c.jpg", fileSize: 20, dateImported: 3 }),
    ];
    const bySize = (x: CatalogPhoto, y: CatalogPhoto) => x.fileSize - y.fileSize;
    expect(
      ids(visiblePhotos(photos, NO_FILTER, "filename", "asc", null, [], bySize)),
    ).toEqual(["b", "c", "a"]);
    expect(
      ids(visiblePhotos(photos, NO_FILTER, "filename", "desc", null, [], bySize)),
    ).toEqual(["a", "c", "b"]);
  });

  it("falls back to dateImported when the custom comparator ties", () => {
    const photos = [
      photo({ id: "late", dateImported: 30 }),
      photo({ id: "early", dateImported: 10 }),
    ];
    expect(
      ids(visiblePhotos(photos, NO_FILTER, "filename", "asc", null, [], () => 0)),
    ).toEqual(["early", "late"]);
  });

  it("leaves the caller's array untouched", () => {
    const photos = [
      photo({ id: "b", dateImported: 20 }),
      photo({ id: "a", dateImported: 10 }),
    ];
    const result = visiblePhotos(photos, NO_FILTER, "dateImported", "asc");
    expect(ids(photos)).toEqual(["b", "a"]);
    expect(result).not.toBe(photos);
  });
});
