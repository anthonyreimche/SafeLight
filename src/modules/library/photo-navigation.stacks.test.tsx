// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A collapsed stack contributes its cover alone to everything that walks the grid:
// the tiles, ←/→ culling, select all and the filmstrip. Filters narrow a stack's
// members first, and the stack collapses over what is left.

import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { CatalogPhoto } from "@/catalog/types";
import { useCatalogStore } from "@/state/catalog-store";
import { useUIStore } from "@/state/ui-store";
import { registerGridFilter, useRegistry } from "@/extensions/registry";
import { moveActivePhoto, useVisiblePhotos, useVisibleStack, visibleList, visibleStack } from "./photo-navigation";
import { NO_FILTER } from "./visible-photos";

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

const ids = (list: CatalogPhoto[]) => list.map((p) => p.id);

const burst = (over: Record<string, Partial<CatalogPhoto>> = {}) => [
  photo({ id: "a" }),
  photo({ id: "s1", stackId: "S", ...over.s1 }),
  photo({ id: "s2", stackId: "S", ...over.s2 }),
  photo({ id: "s3", stackId: "S", ...over.s3 }),
  photo({ id: "z" }),
];

beforeEach(() => {
  useRegistry.setState({ gridFilters: {}, librarySorts: {} });
  useUIStore.setState({
    sortField: "filename",
    sortDirection: "asc",
    filter: NO_FILTER,
    activeFolder: null,
    expandedStacks: new Set(),
  });
  useCatalogStore.setState({ photos: burst(), selectedIds: new Set(), activePhotoId: null });
});

describe("a collapsed stack", () => {
  it("shows its cover alone", () => {
    expect(ids(visibleList())).toEqual(["a", "s1", "z"]);
  });

  it("shows the marked cover, in the slot of the stack's first member", () => {
    useCatalogStore.setState({ photos: burst({ s3: { stackCover: true } }) });
    expect(ids(visibleList())).toEqual(["a", "s3", "z"]);
  });

  it("shows every member once it is expanded, and one again when collapsed", () => {
    useUIStore.getState().toggleStack("S");
    expect(ids(visibleList())).toEqual(["a", "s1", "s2", "s3", "z"]);
    useUIStore.getState().toggleStack("S");
    expect(ids(visibleList())).toEqual(["a", "s1", "z"]);
  });

  it("re-renders the grid's hook when a stack opens", () => {
    const { result } = renderHook(() => useVisiblePhotos());
    expect(ids(result.current)).toEqual(["a", "s1", "z"]);
    act(() => useUIStore.getState().toggleStack("S"));
    expect(ids(result.current)).toEqual(["a", "s1", "s2", "s3", "z"]);
  });

  it("is described for its cover's badge", () => {
    expect(visibleStack("s1")).toEqual({ stackId: "S", size: 3, coverId: "s1", expanded: false });
    expect(visibleStack("a")).toBeUndefined();
    const { result } = renderHook(() => useVisibleStack("s1"));
    act(() => useUIStore.getState().toggleStack("S"));
    expect(result.current?.expanded).toBe(true);
  });
});

describe("filters and stacks", () => {
  const notRejected = () =>
    registerGridFilter("cull", { id: "cull.keep", test: (p) => p.flag !== "reject" });

  it("keeps one tile for a stack whose cover is rejected", () => {
    useCatalogStore.setState({
      photos: burst({ s1: { flag: "reject", stackCover: true } }),
    });
    notRejected();
    expect(ids(visibleList())).toEqual(["a", "s2", "z"]);
  });

  it("shows a stack with one member left as an ordinary photo", () => {
    useCatalogStore.setState({
      photos: burst({ s1: { flag: "reject" }, s2: { flag: "reject" } }),
    });
    notRejected();
    expect(ids(visibleList())).toEqual(["a", "s3", "z"]);
    expect(visibleStack("s3")).toBeUndefined();
  });
});

describe("navigation follows what is shown", () => {
  it("steps over the members a collapsed stack hides", () => {
    useCatalogStore.setState({ activePhotoId: "a" });
    moveActivePhoto(1);
    expect(useCatalogStore.getState().activePhotoId).toBe("s1");
    moveActivePhoto(1);
    expect(useCatalogStore.getState().activePhotoId).toBe("z");
  });

  it("steps through the members once the stack is expanded", () => {
    useUIStore.getState().toggleStack("S");
    useCatalogStore.setState({ activePhotoId: "s1" });
    moveActivePhoto(1);
    expect(useCatalogStore.getState().activePhotoId).toBe("s2");
  });
});
