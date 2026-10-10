// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A grid cell fades its preview in once. The grid remounts on every Develop to
// Library switch, so a preview that has already loaded must come back at full
// opacity, while a preview it has never shown still fades in. Cells that still
// need their preview ask the loader to read it ahead of the idle prefill.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import type { CatalogPhoto } from "@/catalog/types";

const loader = vi.hoisted(() => ({
  requestThumbnail: vi.fn<(id: string, opts?: { visible?: boolean }) => void>(),
}));

vi.mock("@/state/thumbnail-loader", () => loader);

import { Thumbnail } from "./Thumbnail";

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

function cell(p: CatalogPhoto) {
  return <Thumbnail photo={p} selected={false} active={false} size={120} onClick={() => {}} />;
}

// Each test names its own URLs: the set of loaded URLs lives for the module's
// lifetime, as it does across remounts in the app.
const imgOf = (container: HTMLElement): HTMLImageElement => {
  const img = container.querySelector("img");
  if (!img) throw new Error("the cell shows no preview");
  return img;
};

describe("Thumbnail fade-in", () => {
  it("fades a preview in once it has loaded", () => {
    const { container } = render(cell(photo({ thumbnailUrl: "blob:fade-new" })));
    const img = imgOf(container);
    expect(img.style.opacity).toBe("0");
    fireEvent.load(img);
    expect(img.style.opacity).toBe("1");
  });

  it("eases the fade out, not in", () => {
    const { container } = render(cell(photo({ thumbnailUrl: "blob:fade-ease" })));
    expect(imgOf(container).style.transition).toBe("opacity 150ms ease-out");
  });

  it("shows a preview that already loaded at full opacity after a remount", () => {
    const first = render(cell(photo({ thumbnailUrl: "blob:fade-seen" })));
    fireEvent.load(imgOf(first.container));
    first.unmount();

    const second = render(cell(photo({ thumbnailUrl: "blob:fade-seen" })));
    expect(imgOf(second.container).style.opacity).toBe("1");
  });

  it("renders a seen preview at full opacity on the first pass", () => {
    const first = render(cell(photo({ thumbnailUrl: "blob:fade-first-pass" })));
    fireEvent.load(imgOf(first.container));
    first.unmount();

    // Server rendering runs no effects, so this is the cell's very first render.
    expect(renderToString(cell(photo({ thumbnailUrl: "blob:fade-first-pass" })))).toMatch(
      /opacity:1[;"]/,
    );
  });

  it("still fades in a URL the grid has not shown before", () => {
    const first = render(cell(photo({ thumbnailUrl: "blob:fade-old" })));
    fireEvent.load(imgOf(first.container));
    first.unmount();

    const second = render(cell(photo({ thumbnailUrl: "blob:fade-fresh" })));
    expect(imgOf(second.container).style.opacity).toBe("0");
  });

  it("fades the new image in when a mounted cell's preview is replaced", () => {
    const { container, rerender } = render(cell(photo({ thumbnailUrl: "blob:fade-a" })));
    fireEvent.load(imgOf(container));
    rerender(cell(photo({ thumbnailUrl: "blob:fade-b" })));
    expect(imgOf(container).style.opacity).toBe("0");
    fireEvent.load(imgOf(container));
    expect(imgOf(container).style.opacity).toBe("1");
  });

  it("keeps a rejected photo dimmed after a remount", () => {
    const rejected = photo({ thumbnailUrl: "blob:fade-reject", flag: "reject" });
    const first = render(cell(rejected));
    fireEvent.load(imgOf(first.container));
    expect(imgOf(first.container).style.opacity).toBe("0.4");
    first.unmount();

    const second = render(cell(rejected));
    expect(imgOf(second.container).style.opacity).toBe("0.4");
  });
});

describe("Thumbnail preview request", () => {
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

  it("asks for a visible preview ahead of the idle prefill", () => {
    render(cell(photo({ id: "vis" })));
    intersect?.([{ isIntersecting: true }]);
    expect(loader.requestThumbnail).toHaveBeenCalledTimes(1);
    expect(loader.requestThumbnail).toHaveBeenCalledWith("vis", { visible: true });
  });

  it("asks for nothing while the cell is out of view", () => {
    render(cell(photo({ id: "far" })));
    intersect?.([{ isIntersecting: false }]);
    expect(loader.requestThumbnail).not.toHaveBeenCalled();
  });
});
