// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A list row without its preview asks the loader for it once it is near the
// viewport: rows past the idle prefill, or whose preview was released, would
// otherwise stay blank.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import type { CatalogPhoto } from "@/catalog/types";

const loader = vi.hoisted(() => ({
  requestThumbnail: vi.fn<(id: string, opts?: { visible?: boolean }) => void>(),
  cancelThumbnail: vi.fn<(id: string) => void>(),
}));

vi.mock("@/state/thumbnail-loader", () => loader);

import { LibraryListRow } from "./LibraryListRow";

function photo(over: Partial<CatalogPhoto> = {}): CatalogPhoto {
  return {
    id: "p1",
    filename: "p1.NEF",
    relPath: "p1.NEF",
    folder: "",
    directoryHandle: null,
    fileHandle: null,
    thumbnailBlob: null,
    thumbnailUrl: null,
    width: 6000,
    height: 4000,
    fileSize: 1024,
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

const row = (p: CatalogPhoto) => (
  <LibraryListRow photo={p} selected={false} active={false} onClick={() => {}} onDoubleClick={() => {}} />
);

describe("LibraryListRow preview request", () => {
  let intersect: ((entries: Partial<IntersectionObserverEntry>[]) => void) | null = null;

  beforeEach(() => {
    loader.requestThumbnail.mockClear();
    intersect = null;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: (entries: Partial<IntersectionObserverEntry>[]) => void) {
          intersect = cb;
        }
        observe(): void {}
        disconnect(): void {}
      },
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it("asks for a missing preview once the row is near the viewport", () => {
    render(row(photo({ id: "vis" })));
    intersect?.([{ isIntersecting: true }]);
    expect(loader.requestThumbnail).toHaveBeenCalledWith("vis", { visible: true });
  });

  it("asks for nothing while the row is out of view", () => {
    render(row(photo({ id: "far" })));
    intersect?.([{ isIntersecting: false }]);
    expect(loader.requestThumbnail).not.toHaveBeenCalled();
  });

  it("watches nothing when the row already has its preview", () => {
    render(row(photo({ thumbnailUrl: "blob:row-has" })));
    expect(intersect).toBeNull();
  });
});
