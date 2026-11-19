// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The badges in a thumbnail's top-right corner, beside the flag: whether the
// photo is edited and its file type, each shown while Preferences ▸ Library asks
// for it, and each badge an extension registers, drawn for the cell's photo. The Library grid and the Filmstrip both
// draw their cells with Thumbnail, so both show them.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { CatalogPhoto } from "@/catalog/types";

vi.mock("@/state/thumbnail-loader", () => ({
  requestThumbnail: vi.fn(),
  cancelThumbnail: vi.fn(),
}));

import { catalogStorage, setCatalogStorage } from "@/catalog/storage";
import { installMemoryStorage, snapshot } from "@/catalog/stored-edit.fixtures";
import type { EditState } from "@/catalog/types";
import { registerThumbnailBadge, unregisterThumbnailBadge, useRegistry } from "@/extensions/registry";
import { DEFAULT_SETTINGS, updateSettings } from "@/state/settings-store";
import { Thumbnail } from "./Thumbnail";
import { ThumbnailBadge } from "./ThumbnailBadge";

function photo(over: Partial<CatalogPhoto> = {}): CatalogPhoto {
  return {
    id: "p1",
    filename: "IMG_0001.NEF",
    relPath: "IMG_0001.NEF",
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

/** A history with one step after the original. */
const edited = (photoId: string): EditState => ({
  photoId,
  stack: [snapshot("Original", {}), snapshot("Exposure", { exposure: 1 })],
  currentIndex: 1,
});

const cell = (p: CatalogPhoto) => (
  <Thumbnail photo={p} selected={false} active={false} size={120} onClick={() => {}} />
);

beforeEach(() => {
  // A cell without its preview watches for coming into view.
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  useRegistry.setState({ thumbnailBadges: {} });
  updateSettings({ thumbnailFileType: false, thumbnailEdited: true });
});

afterEach(() => {
  cleanup();
  setCatalogStorage(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("edited badge", () => {
  it("is on by default", () => {
    expect(DEFAULT_SETTINGS.thumbnailEdited).toBe(true);
  });

  it("marks a photo with an edit, and only that one", () => {
    installMemoryStorage(edited("a"));
    render(
      <>
        {cell(photo({ id: "a" }))}
        {cell(photo({ id: "b" }))}
      </>,
    );
    expect(screen.getAllByLabelText("Edited")).toHaveLength(1);
    expect(document.querySelector('[data-photo-id="a"] [aria-label="Edited"]')).toBeTruthy();
  });

  it("appears once an edit is stored, and goes when every step is undone", async () => {
    installMemoryStorage();
    render(cell(photo({ id: "a" })));
    expect(screen.queryByLabelText("Edited")).toBeNull();
    await act(async () => {
      await catalogStorage().putEditState(edited("a"));
    });
    expect(screen.getByLabelText("Edited")).toBeTruthy();
    await act(async () => {
      await catalogStorage().putEditState({ ...edited("a"), currentIndex: 0 });
    });
    expect(screen.queryByLabelText("Edited")).toBeNull();
  });

  it("hides while the preference is off", () => {
    installMemoryStorage(edited("a"));
    render(cell(photo({ id: "a" })));
    act(() => updateSettings({ thumbnailEdited: false }));
    expect(screen.queryByLabelText("Edited")).toBeNull();
  });

  it("sits between the extension badges and the file type", () => {
    installMemoryStorage(edited("a"));
    updateSettings({ thumbnailFileType: true });
    registerThumbnailBadge("ext.a", { id: "ext.a", component: () => <ThumbnailBadge>A</ThumbnailBadge> });
    const { container } = render(cell(photo({ id: "a", flag: "pick" })));
    const row = container.querySelector("[data-thumbnail-badges]");
    expect([...(row?.children ?? [])].map((c) => c.getAttribute("aria-label") ?? c.textContent)).toEqual([
      "A",
      "Edited",
      "NEF file",
      "Pick",
    ]);
  });
});

describe("file type badge", () => {
  it("is off by default", () => {
    render(cell(photo()));
    expect(screen.queryByText("NEF")).toBeNull();
  });

  it("shows the file's extension in capitals once turned on", () => {
    updateSettings({ thumbnailFileType: true });
    render(cell(photo({ filename: "pair.jpeg" })));
    expect(screen.getByText("JPEG")).toBeTruthy();
  });

  it("follows the preference while the cell is shown", () => {
    render(cell(photo()));
    act(() => updateSettings({ thumbnailFileType: true }));
    expect(screen.getByText("NEF")).toBeTruthy();
  });

  it("shows nothing for a file without an extension", () => {
    updateSettings({ thumbnailFileType: true });
    const { container } = render(cell(photo({ filename: "README" })));
    expect(container.querySelector("[data-thumbnail-badges]")?.textContent ?? "").toBe("");
  });
});

describe("extension badges", () => {
  it("draws each registered badge for the cell's photo", () => {
    registerThumbnailBadge("ext.gps", {
      id: "ext.gps.badge",
      component: ({ photo: p }) => (p.exif.gpsLatitude !== undefined ? <ThumbnailBadge title="Has a location">GPS</ThumbnailBadge> : null),
    });
    render(
      <>
        {cell(photo({ id: "a", exif: { gpsLatitude: 49 } }))}
        {cell(photo({ id: "b" }))}
      </>,
    );
    expect(screen.getAllByText("GPS")).toHaveLength(1);
    expect(screen.getByTitle("Has a location")).toBeTruthy();
  });

  it("orders badges by `order`, the file type nearest the flag", () => {
    updateSettings({ thumbnailFileType: true });
    registerThumbnailBadge("ext.b", { id: "ext.b", order: 200, component: () => <ThumbnailBadge>B</ThumbnailBadge> });
    registerThumbnailBadge("ext.a", { id: "ext.a", order: 10, component: () => <ThumbnailBadge>A</ThumbnailBadge> });
    const { container } = render(cell(photo({ flag: "pick" })));
    const row = container.querySelector("[data-thumbnail-badges]");
    expect([...(row?.children ?? [])].map((c) => c.textContent)).toEqual(["A", "B", "NEF", "⚑"]);
  });

  it("keeps the cell when a badge throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    registerThumbnailBadge("ext.bad", {
      id: "ext.bad",
      component: () => {
        throw new Error("boom");
      },
    });
    registerThumbnailBadge("ext.ok", { id: "ext.ok", component: () => <ThumbnailBadge>OK</ThumbnailBadge> });
    render(cell(photo()));
    expect(screen.getByText("OK")).toBeTruthy();
    expect(screen.getByRole("option")).toBeTruthy();
  });

  it("goes when it is unregistered", () => {
    registerThumbnailBadge("ext.gps", { id: "ext.gps.badge", component: () => <ThumbnailBadge>GPS</ThumbnailBadge> });
    render(cell(photo()));
    expect(screen.getByText("GPS")).toBeTruthy();
    act(() => unregisterThumbnailBadge("ext.gps", "ext.gps.badge"));
    expect(screen.queryByText("GPS")).toBeNull();
  });
});
