// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The photos a command acts on: the selection, else the photo in front.

import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { targetPhotoIds, useTargetPhotos } from "./target-photos";
import { useCatalogStore } from "./catalog-store";
import type { CatalogPhoto } from "@/catalog/types";

const photo = (id: string) => ({ id }) as CatalogPhoto;

beforeEach(() => {
  useCatalogStore.setState({ photos: [photo("a"), photo("b"), photo("c")], selectedIds: new Set(), activePhotoId: null });
});

describe("targetPhotoIds", () => {
  it("is the selection when there is one", () => {
    expect(targetPhotoIds({ selectedIds: new Set(["c", "a"]), activePhotoId: "b" })).toEqual(["c", "a"]);
  });

  it("is the active photo when nothing is selected", () => {
    expect(targetPhotoIds({ selectedIds: new Set(), activePhotoId: "b" })).toEqual(["b"]);
  });

  it("is nothing with neither", () => {
    expect(targetPhotoIds({ selectedIds: new Set(), activePhotoId: null })).toEqual([]);
  });
});

describe("useTargetPhotos", () => {
  it("gives the target photos in the catalogue's order and follows the selection", () => {
    const { result } = renderHook(() => useTargetPhotos());
    expect(result.current).toEqual([]);
    act(() => useCatalogStore.setState({ selectedIds: new Set(["c", "a"]) }));
    expect(result.current.map((p) => p.id)).toEqual(["a", "c"]);
    act(() => useCatalogStore.setState({ selectedIds: new Set(), activePhotoId: "b" }));
    expect(result.current.map((p) => p.id)).toEqual(["b"]);
  });
});
