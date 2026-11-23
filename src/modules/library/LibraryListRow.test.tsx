// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A list row without its preview asks the loader for it once it is near the
// viewport: rows past the idle prefill, or whose preview was released, would
// otherwise stay blank.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
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

describe("LibraryListRow preview fade", () => {
  beforeEach(() =>
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe(): void {}
        disconnect(): void {}
      },
    ),
  );

  afterEach(() => vi.unstubAllGlobals());

  const imgOf = (container: HTMLElement): HTMLImageElement => {
    const img = container.querySelector("img");
    if (!img) throw new Error("the row shows no preview");
    return img;
  };

  it("breathes a skeleton, not an emoji, while there is no preview", () => {
    const { container } = render(row(photo()));
    expect(container.querySelector(".sl-breathe")).toBeTruthy();
    expect(container.textContent).not.toContain("🖼");
  });

  it("shows a still mark with the reason, not a skeleton, when the decode failed", () => {
    const { container } = render(row(photo({ decodeError: "Unsupported camera" })));
    expect(container.querySelector(".sl-breathe")).toBeNull();
    expect(container.querySelector('[title*="Unsupported camera"]')).toBeTruthy();
  });

  it("fades a new preview in once it has loaded", () => {
    const { container } = render(row(photo({ thumbnailUrl: "blob:row-new" })));
    expect(imgOf(container).style.opacity).toBe("0");
    fireEvent.load(imgOf(container));
    expect(imgOf(container).style.opacity).toBe("1");
  });

  it("shows a preview that already loaded at full opacity after a remount", () => {
    const first = render(row(photo({ thumbnailUrl: "blob:row-seen" })));
    fireEvent.load(imgOf(first.container));
    first.unmount();
    const second = render(row(photo({ thumbnailUrl: "blob:row-seen" })));
    expect(imgOf(second.container).style.opacity).toBe("1");
  });

  it("keeps a loaded row shown when its own preview is replaced", () => {
    const { container, rerender } = render(row(photo({ thumbnailUrl: "blob:row-a" })));
    fireEvent.load(imgOf(container));
    rerender(row(photo({ thumbnailUrl: "blob:row-b" })));
    expect(imgOf(container).style.opacity).toBe("1");
  });

  it("dims only the preview of a rejected photo, keeping its name readable", () => {
    const { container } = render(row(photo({ flag: "reject", thumbnailUrl: "blob:row-rej" })));
    fireEvent.load(imgOf(container));
    expect(imgOf(container).style.opacity).toBe("0.4");
    expect(container.querySelector(".opacity-40")).toBeNull();
  });

  it("starts a different photo's preview hidden", () => {
    const { container, rerender } = render(row(photo({ id: "p1", thumbnailUrl: "blob:row-c" })));
    fireEvent.load(imgOf(container));
    rerender(row(photo({ id: "p2", thumbnailUrl: "blob:row-d" })));
    expect(imgOf(container).style.opacity).toBe("0");
  });
});
