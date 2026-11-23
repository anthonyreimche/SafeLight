// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A grid cell reached from the keyboard shows what hovering shows: the strip
// with the stars and the file name, over the same darkened preview.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { CatalogPhoto } from "@/catalog/types";

vi.mock("@/state/thumbnail-loader", () => ({
  requestThumbnail: vi.fn(),
  cancelThumbnail: vi.fn(),
}));

import { setCatalogStorage } from "@/catalog/storage";
import { installMemoryStorage } from "@/catalog/stored-edit.fixtures";
import { Thumbnail } from "./Thumbnail";

const photo: CatalogPhoto = {
  id: "p1",
  filename: "IMG_0001.DNG",
  relPath: "IMG_0001.DNG",
  folder: "",
  directoryHandle: null,
  fileHandle: null,
  thumbnailBlob: null,
  thumbnailUrl: "blob:p1",
  width: 4072,
  height: 3044,
  fileSize: 1024,
  mimeType: "image/x-adobe-dng",
  rating: 2,
  colorLabel: "none",
  flag: "none",
  rotation: 0,
  keywords: ["dog"],
  dateCreated: 0,
  dateImported: 0,
  exif: {},
};

beforeEach(() => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  installMemoryStorage();
  render(
    <Thumbnail
      photo={photo}
      selected={false}
      active={false}
      size={160}
      onClick={() => {}}
      onRatingChange={() => {}}
    />,
  );
});

afterEach(() => {
  cleanup();
  setCatalogStorage(null);
  vi.unstubAllGlobals();
});

describe("thumbnail keyboard focus", () => {
  it("shows the hover strip and hides the corner badges, as hover does", () => {
    const strip = screen.getByText("IMG_0001.DNG").parentElement as HTMLElement;
    expect(strip.className).toContain("group-focus-visible:opacity-100");
    expect(screen.getByText("★★").className).toContain("group-focus-visible:opacity-0");
    expect(screen.getByTitle("dog").className).toContain("group-focus-visible:opacity-0");
    expect(screen.getByRole("img", { name: "IMG_0001.DNG" }).className).toContain(
      "group-focus-visible:brightness-50",
    );
  });
});
