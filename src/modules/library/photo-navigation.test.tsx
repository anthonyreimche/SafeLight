// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// useVisiblePhotos applies every extension grid filter unless the caller names
// its own to leave out — a surface that both filters the grid and displays
// photos (the Map) must not narrow itself by its own filter.

import { beforeEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import type { CatalogPhoto } from "@/catalog/types";
import { useCatalogStore } from "@/state/catalog-store";
import { registerGridFilter, useRegistry } from "@/extensions/registry";
import { useVisiblePhotos } from "./photo-navigation";

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

const ids = (list: CatalogPhoto[]) => list.map((p) => p.id).sort();

beforeEach(() => {
  useRegistry.setState({ gridFilters: {} });
  useCatalogStore.setState({
    photos: [photo({ id: "a", rating: 5 }), photo({ id: "b", rating: 3 }), photo({ id: "c" })],
  });
  registerGridFilter("map", { id: "map.in-view", test: (p) => p.rating === 5 });
  registerGridFilter("search", { id: "search.text", test: (p) => p.id !== "c" });
});

describe("useVisiblePhotos", () => {
  it("applies every grid filter by default", () => {
    const { result } = renderHook(() => useVisiblePhotos());
    expect(ids(result.current)).toEqual(["a"]);
  });

  it("leaves out only the named filters", () => {
    const { result } = renderHook(() => useVisiblePhotos({ without: ["map.in-view"] }));
    expect(ids(result.current)).toEqual(["a", "b"]);
  });

  it("ignores names that match no filter", () => {
    const { result } = renderHook(() => useVisiblePhotos({ without: ["nope"] }));
    expect(ids(result.current)).toEqual(["a"]);
  });

  it("keeps the list's identity when each render passes a fresh `without` literal", () => {
    const { result, rerender } = renderHook(() =>
      useVisiblePhotos({ without: ["map.in-view"] }),
    );
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
