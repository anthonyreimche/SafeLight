// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// useVisiblePhotos applies every extension grid filter unless the caller names
// its own to leave out — a surface that both filters the grid and displays
// photos (the Map) must not narrow itself by its own filter.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { CatalogPhoto } from "@/catalog/types";
import { useCatalogStore } from "@/state/catalog-store";
import { useUIStore } from "@/state/ui-store";
import {
  registerGridFilter,
  registerLibrarySort,
  unregisterExtension,
  useRegistry,
} from "@/extensions/registry";
import { CALLBACK_FAILURE_LIMIT, useCallbackFailures } from "@/extensions/guard";
import { useVisiblePhotos, visibleList } from "./photo-navigation";

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

const initialSort = useUIStore.getState().sortField;

beforeEach(() => {
  useRegistry.setState({ gridFilters: {} });
  useUIStore.setState({ sortField: initialSort });
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

  it("follows a filter re-registered with the same function reading outside state", () => {
    useRegistry.setState({ gridFilters: {} });
    let wanted = "a";
    const test = (p: CatalogPhoto) => p.id === wanted;
    registerGridFilter("search", { id: "search.text", test });
    const { result } = renderHook(() => useVisiblePhotos());
    expect(ids(result.current)).toEqual(["a"]);
    expect(ids(visibleList())).toEqual(["a"]);
    wanted = "b";
    act(() => registerGridFilter("search", { id: "search.text", test }));
    expect(ids(result.current)).toEqual(["b"]);
    expect(ids(visibleList())).toEqual(["b"]);
  });

  it("follows a sort re-registered with the same comparator reading outside state", () => {
    useRegistry.setState({ gridFilters: {}, librarySorts: {} });
    useUIStore.setState({ sortField: "ext.order", sortDirection: "asc" });
    let rank: Record<string, number> = { a: 0, b: 1, c: 2 };
    const compare = (x: CatalogPhoto, y: CatalogPhoto) => rank[x.id] - rank[y.id];
    registerLibrarySort("ext", { id: "ext.order", label: "Order", compare });
    const order = () => visibleList().map((p) => p.id);
    expect(order()).toEqual(["a", "b", "c"]);
    rank = { a: 2, b: 1, c: 0 };
    registerLibrarySort("ext", { id: "ext.order", label: "Order", compare });
    expect(order()).toEqual(["c", "b", "a"]);
  });

  it("shows the photos a throwing grid filter was asked about, and keeps the other filters", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    registerGridFilter("broken", {
      id: "broken.filter",
      test: () => {
        throw new Error("filter blew up");
      },
    });
    const { result } = renderHook(() => useVisiblePhotos());
    expect(ids(result.current)).toEqual(["a"]);
    expect(ids(visibleList())).toEqual(["a"]);
    error.mockRestore();
  });

  it("calls a switched-off grid filter again once its extension is unloaded and registers it anew", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    useRegistry.setState({ gridFilters: {} });
    let broken = true;
    const test = (p: CatalogPhoto) => {
      if (broken) throw new Error("not ready");
      return p.id === "b";
    };
    registerGridFilter("flaky", { id: "flaky.filter", test });
    for (let i = 0; i < CALLBACK_FAILURE_LIMIT; i++) {
      registerGridFilter("flaky", { id: "flaky.filter", test });
      visibleList();
    }
    expect(useCallbackFailures.getState().flaky).toBeDefined();

    // Turned off and on again: the same bundle hands back the same function.
    unregisterExtension("flaky");
    broken = false;
    registerGridFilter("flaky", { id: "flaky.filter", test });
    expect(ids(visibleList())).toEqual(["b"]);
    error.mockRestore();
  });

  it("falls back to the date order when an extension sort throws", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    useRegistry.setState({ gridFilters: {}, librarySorts: {} });
    useCatalogStore.setState({
      photos: [photo({ id: "late", dateImported: 2 }), photo({ id: "early", dateImported: 1 })],
    });
    useUIStore.setState({ sortField: "broken.order", sortDirection: "asc" });
    registerLibrarySort("broken", {
      id: "broken.order",
      label: "Broken",
      compare: () => {
        throw new Error("compare blew up");
      },
    });
    const { result } = renderHook(() => useVisiblePhotos());
    expect(result.current.map((p) => p.id)).toEqual(["early", "late"]);
    error.mockRestore();
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
