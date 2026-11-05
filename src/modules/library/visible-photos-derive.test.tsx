// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The grid's filter + sort runs over the whole catalogue, so it must run only
// when something it reads changes: not on every preview the open-time loader
// attaches (once per frame while a big catalogue fills in), not once per surface
// showing the list, and not on every arrow key.

import { act, renderHook } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto } from "@/catalog/types";
import type { LoadedPreview } from "@/state/thumbnail-loader";

const derives = vi.hoisted(() => ({ count: 0 }));

vi.mock("./visible-photos", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./visible-photos")>();
  return {
    ...actual,
    visibleOrder: (...args: Parameters<typeof actual.visibleOrder>) => {
      derives.count++;
      return actual.visibleOrder(...args);
    },
  };
});

import { installMemoryStorage } from "@/catalog/stored-edit.fixtures";
import { useCatalogStore } from "@/state/catalog-store";
import { useUIStore } from "@/state/ui-store";
import { registerGridFilter, registerLibrarySort, useRegistry } from "@/extensions/registry";
import { moveActivePhoto, useVisiblePhotos, visibleList } from "./photo-navigation";
import { NO_FILTER } from "./visible-photos";

const N = 50_000;

function photo(i: number): CatalogPhoto {
  const id = `p${i}`;
  return {
    id,
    filename: `IMG_${String((i * 7919) % N).padStart(5, "0")}.NEF`,
    relPath: id,
    folder: "",
    directoryHandle: null,
    fileHandle: null,
    thumbnailBlob: null,
    thumbnailUrl: null,
    width: 6000,
    height: 4000,
    fileSize: 1000,
    mimeType: "image/x-nikon-nef",
    rating: i % 6,
    colorLabel: "none",
    flag: "none",
    rotation: 0,
    keywords: [],
    dateCreated: i,
    dateImported: i,
    exif: {},
  };
}

const preview = (): LoadedPreview => new Blob(["jpg"]);

const createObjectURL = URL.createObjectURL;
const revokeObjectURL = URL.revokeObjectURL;
let urls = 0;
beforeAll(() => {
  URL.createObjectURL = () => `blob:preview-${++urls}`;
  URL.revokeObjectURL = () => {};
});
afterAll(() => {
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
});

beforeEach(() => {
  useRegistry.setState({ gridFilters: {}, librarySorts: {} });
  useUIStore.setState({
    sortField: "filename",
    sortDirection: "asc",
    activeFolder: null,
    filter: NO_FILTER,
  });
  useCatalogStore.setState({
    photos: Array.from({ length: N }, (_, i) => photo(i)),
    selectedIds: new Set(),
    activePhotoId: null,
  });
  derives.count = 0;
});

describe("visible photos derive", () => {
  it("doesn't re-derive while previews fill in, however many surfaces show the list", () => {
    const surfaces = [
      renderHook(() => useVisiblePhotos()),
      renderHook(() => useVisiblePhotos()),
      renderHook(() => useVisiblePhotos()),
    ];
    derives.count = 0;
    for (let i = 0; i < 500; i++) {
      act(() => {
        useCatalogStore.getState().mergeThumbnails([{ id: `p${i}`, blob: preview() }]);
      });
    }
    console.info(`[derive count] 500 preview flushes x ${surfaces.length} surfaces: ${derives.count}`);
    expect(derives.count).toBeLessThanOrEqual(1);
    // Each surface shows the photo as it is now, preview included.
    const shown = surfaces[0].result.current.find((p) => p.id === "p499");
    expect(shown?.thumbnailUrl).toMatch(/^blob:preview-/);
  });

  it("doesn't re-derive on each step through the list", () => {
    useCatalogStore.getState().select("p0");
    derives.count = 0;
    for (let i = 0; i < 50; i++) moveActivePhoto(1);
    console.info(`[derive count] 50 arrow steps: ${derives.count}`);
    expect(derives.count).toBeLessThanOrEqual(1);
  });

  it("re-derives once a field the filter or sort reads changes", async () => {
    installMemoryStorage();
    useUIStore.setState({ sortField: "rating" });
    const { result } = renderHook(() => useVisiblePhotos());
    const target = result.current[0].id;
    await act(async () => {
      await useCatalogStore.getState().setRating(target, 5);
    });
    expect(result.current.find((p) => p.id === target)?.rating).toBe(5);
    expect(result.current[0].id).not.toBe(target);
  });

  it("re-derives when a rebuild changes more than the preview", () => {
    useUIStore.setState({ sortField: "dateCreated" });
    const { result } = renderHook(() => useVisiblePhotos());
    act(() => {
      useCatalogStore.getState().mergeRebuiltPhoto("p0", { dateCreated: N * 2 });
    });
    expect(result.current[result.current.length - 1].id).toBe("p0");
  });

  it("re-derives when the catalogue is set wholesale", () => {
    const { result } = renderHook(() => useVisiblePhotos());
    act(() => {
      useCatalogStore.setState({ photos: [photo(1), photo(2)] });
    });
    expect(result.current.map((p) => p.id).sort()).toEqual(["p1", "p2"]);
  });

  describe("when a rating, flag, label or keyword changes", () => {
    const RATED = 20;
    const rateEach = async () => {
      for (let i = 0; i < RATED; i++) {
        await act(async () => {
          await useCatalogStore.getState().setRating(`p${i}`, (i + 1) % 6);
        });
      }
    };

    beforeEach(() => {
      installMemoryStorage();
    });

    it("keeps the order while nothing in use reads the field", async () => {
      const { result } = renderHook(() => useVisiblePhotos());
      derives.count = 0;
      await rateEach();
      await act(async () => {
        await useCatalogStore.getState().setColorLabel("p0", "red");
        await useCatalogStore.getState().setFlag("p1", "pick");
        await useCatalogStore.getState().addKeyword("p2", "trip");
      });
      console.info(`[derive count] ${RATED} setRating + label + flag + keyword, sorted by name: ${derives.count}`);
      expect(derives.count).toBe(0);
      const shown = (id: string) => result.current.find((p) => p.id === id);
      expect(shown("p3")?.rating).toBe(4);
      expect(shown("p0")?.colorLabel).toBe("red");
      expect(shown("p1")?.flag).toBe("pick");
      expect(shown("p2")?.keywords).toEqual(["trip"]);
      expect(visibleList()).toBe(result.current);
    });

    it("re-sorts each time while the grid is sorted by rating", async () => {
      useUIStore.setState({ sortField: "rating" });
      renderHook(() => useVisiblePhotos());
      derives.count = 0;
      await rateEach();
      console.info(`[derive count] ${RATED} setRating, sorted by rating: ${derives.count}`);
      expect(derives.count).toBe(RATED);
      const list = visibleList();
      for (let i = 1; i < list.length; i++) expect(list[i].rating).toBeGreaterThanOrEqual(list[i - 1].rating);
    });

    it("re-filters while the grid is filtered by rating", async () => {
      useUIStore.setState({ filter: { ...NO_FILTER, rating: 5 } });
      const { result } = renderHook(() => useVisiblePhotos());
      const has = (id: string) => result.current.some((p) => p.id === id);
      expect(has("p0")).toBe(false);
      expect(has("p5")).toBe(true);
      await act(async () => {
        await useCatalogStore.getState().setRating("p0", 5);
        await useCatalogStore.getState().setRating("p5", 1);
      });
      expect(has("p0")).toBe(true);
      expect(has("p5")).toBe(false);
    });

    it("re-filters on the field it filters by and ignores the others", async () => {
      useUIStore.setState({ filter: { ...NO_FILTER, flag: "pick" } });
      const { result } = renderHook(() => useVisiblePhotos());
      derives.count = 0;
      await act(async () => {
        await useCatalogStore.getState().setRating("p0", 3);
      });
      expect(derives.count).toBe(0);
      await act(async () => {
        await useCatalogStore.getState().setFlag("p0", "pick");
      });
      expect(derives.count).toBe(1);
      expect(result.current.map((p) => p.id)).toEqual(["p0"]);
    });

    it("re-derives for any change while an extension filter or sort is in use", async () => {
      registerGridFilter("ext", { id: "ext.filter", test: (p) => p.keywords.length === 0 });
      const { result } = renderHook(() => useVisiblePhotos());
      derives.count = 0;
      await act(async () => {
        await useCatalogStore.getState().addKeyword("p0", "hidden");
      });
      expect(derives.count).toBe(1);
      expect(result.current.some((p) => p.id === "p0")).toBe(false);

      registerLibrarySort("ext", {
        id: "ext.rating",
        label: "Rating",
        compare: (a, b) => b.rating - a.rating,
      });
      useUIStore.setState({ sortField: "ext.rating" });
      renderHook(() => useVisiblePhotos());
      derives.count = 0;
      await act(async () => {
        await useCatalogStore.getState().setRating("p1", 5);
      });
      expect(derives.count).toBe(1);
    });
  });

  it("sorts once for an open: skeletons, the grid's read, then the rescan that only attaches handles", () => {
    const skeletons = Array.from({ length: N }, (_, i) => photo(i));
    const rescanned = skeletons.map((p) => ({ ...p, exif: {}, keywords: [] }));
    useCatalogStore.getState().finalizeCatalog(skeletons);
    const { rerender } = renderHook(() => useVisiblePhotos());
    visibleList();
    useCatalogStore.getState().reconcileCatalog(rescanned);
    rerender();
    visibleList();
    console.info(`[derive count] open (skeletons, grid, rescan): ${derives.count}`);
    expect(derives.count).toBe(1);
  });

  it("re-derives when previews fill in and a field changes in the same catalogue", () => {
    useUIStore.setState({ sortField: "dateCreated" });
    const { result } = renderHook(() => useVisiblePhotos());
    act(() => {
      useCatalogStore.getState().mergeThumbnails([{ id: "p0", blob: preview() }]);
      useCatalogStore.getState().mergeRebuiltPhoto("p0", { dateCreated: N * 2 });
      useCatalogStore.getState().mergeThumbnails([{ id: "p1", blob: preview() }]);
    });
    const list = result.current;
    expect(list[list.length - 1].id).toBe("p0");
    expect(list.find((p) => p.id === "p1")?.thumbnailUrl).toMatch(/^blob:preview-/);
  });
});
