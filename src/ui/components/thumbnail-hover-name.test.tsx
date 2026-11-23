// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The strip a thumbnail shows on hover: the stars, then the file name under them
// on the darkest part of the scrim. The scrim is black in every theme, so the
// name takes the on-media colour, not the theme's text colour (dark in a light
// theme, where it vanished into the scrim — #265).

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
  thumbnailUrl: null,
  width: 4072,
  height: 3044,
  fileSize: 1024,
  mimeType: "image/x-adobe-dng",
  rating: 2,
  colorLabel: "none",
  flag: "none",
  rotation: 0,
  keywords: [],
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

describe("thumbnail hover strip", () => {
  it("draws the name in the on-media colour, whatever the theme", () => {
    const name = screen.getByText("IMG_0001.DNG");
    expect(name.className).toContain("text-on-media");
    expect(name.className).not.toContain("text-text-primary");
  });

  it("puts the name under the stars", () => {
    const name = screen.getByText("IMG_0001.DNG");
    const stars = screen.getByRole("group", { name: /Rating/ });
    expect(stars.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
