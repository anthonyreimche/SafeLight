// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Export file names. An EXIF value such as a lens named "EF24-70mm f/2.8L"
// lands in a template's output, and the folder handle rejects a name with a
// path separator, so that photo failed to export. Names that differ only in
// case are one file on Windows and macOS, so a batch must not produce two.

import { describe, expect, it, vi } from "vitest";
import type { CatalogPhoto, ExifData } from "@/catalog/types";

vi.mock("@/rendering/webgl/renderer", () => ({ WebGLRenderer: class {} }));
vi.mock("@/rendering/render-bridge", () => ({ getStageTextures: () => ({}) }));
vi.mock("@/extensions/registry", () => ({ useRegistry: { getState: () => ({}) } }));
vi.mock("@/state/settings-store", () => ({ getSettings: () => ({}) }));

import {
  exportFilename,
  resolveFilenameTemplate,
  safeFileName,
  uniqueName,
} from "./export-image";

function photo(filename: string, exif: ExifData = {}, copyName?: string): CatalogPhoto {
  return {
    id: filename,
    filename,
    relPath: filename,
    folder: "",
    directoryHandle: null,
    fileHandle: null,
    thumbnailBlob: null,
    thumbnailUrl: null,
    width: 6000,
    height: 4000,
    fileSize: 8,
    mimeType: "image/x-canon-cr3",
    rating: 0,
    colorLabel: "none",
    flag: "none",
    rotation: 0,
    keywords: [],
    dateCreated: 0,
    dateImported: 0,
    exif,
    copyName,
  };
}

describe("resolveFilenameTemplate", () => {
  it("fills the built-in variables from the photo", () => {
    const p = photo("IMG_0001.CR3", { dateTimeOriginal: "2024:03:05 10:00:00" });
    expect(resolveFilenameTemplate("{year}-{month}-{day}_{filename}", p, "image/jpeg")).toBe(
      "2024-03-05_IMG_0001.jpg",
    );
  });

  it("keeps a path separator in a lens name out of the file name", () => {
    const p = photo("IMG_0001.CR3", { lens: "EF24-70mm f/2.8L" });
    const name = resolveFilenameTemplate("{lens}", p, "image/jpeg");
    expect(name).not.toContain("/");
    expect(name).toBe("EF24-70mm f-2.8L.jpg");
  });

  it("replaces every character Windows forbids and merges a run into one dash", () => {
    const p = photo("IMG_0001.CR3", { cameraModel: "A:B*C" });
    expect(resolveFilenameTemplate("{camera}_x", p, "image/jpeg")).toBe("A-B-C_x.jpg");
    const odd = photo("IMG_0001.CR3", { cameraModel: 'a\\b?c"d<e>f|g' });
    expect(resolveFilenameTemplate("{camera}", odd, "image/png")).toBe("a-b-c-d-e-f-g.png");
    const run = photo("IMG_0001.CR3", { cameraModel: "A:/*B" });
    expect(resolveFilenameTemplate("{camera}", run, "image/png")).toBe("A-B.png");
  });

  it("leaves an unknown variable as written", () => {
    expect(resolveFilenameTemplate("{nope}_{filename}", photo("a.CR3"), "image/jpeg")).toBe(
      "{nope}_a.jpg",
    );
  });

  it("adds no second extension to a template that already ends with one", () => {
    expect(resolveFilenameTemplate("{filename}.jpg", photo("a.CR3"), "image/jpeg")).toBe("a.jpg");
    expect(resolveFilenameTemplate("{filename}.{ext}", photo("a.CR3"), "image/webp")).toBe(
      "a.webp",
    );
  });

  it("drops trailing dots and spaces before the extension", () => {
    expect(resolveFilenameTemplate("name. ", photo("a.CR3"), "image/jpeg")).toBe("name.jpg");
    expect(resolveFilenameTemplate("name..", photo("a.CR3"), "image/jpeg")).toBe("name.jpg");
    expect(resolveFilenameTemplate("name. .jpg", photo("a.CR3"), "image/jpeg")).toBe("name.jpg");
  });

  it("names a file that resolves to nothing untitled", () => {
    expect(resolveFilenameTemplate("{camera}.jpg", photo("a.CR3"), "image/jpeg")).toBe(
      "untitled.jpg",
    );
    expect(resolveFilenameTemplate("{camera}", photo("a.CR3"), "image/png")).toBe("untitled.png");
  });
});

describe("exportFilename", () => {
  it("is the base name plus the format extension", () => {
    expect(exportFilename(photo("IMG_0001.CR3"), "image/jpeg")).toBe("IMG_0001.jpg");
    expect(exportFilename(photo("IMG_0001.CR3"), "image/tiff")).toBe("IMG_0001.tif");
  });

  it("makes a typed copy name safe", () => {
    expect(exportFilename(photo("IMG_0001.CR3", {}, "a/b"), "image/jpeg")).toBe(
      "IMG_0001_a-b.jpg",
    );
  });
});

describe("safeFileName", () => {
  it("replaces control characters", () => {
    expect(safeFileName("a\u0000b\u001fc\td")).toBe("a-b-c-d");
  });

  it("leaves hyphens that were already there alone", () => {
    expect(safeFileName("2024--03-05")).toBe("2024--03-05");
  });

  it("returns untitled for an empty result", () => {
    expect(safeFileName("")).toBe("untitled");
    expect(safeFileName(" . ")).toBe("untitled");
  });

  it("keeps a leading dot", () => {
    expect(safeFileName(".hidden")).toBe(".hidden");
  });
});

describe("uniqueName", () => {
  it("numbers a repeated name before its extension", () => {
    const used = new Set<string>();
    expect([1, 2, 3].map(() => uniqueName("a.jpg", used))).toEqual([
      "a.jpg",
      "a (2).jpg",
      "a (3).jpg",
    ]);
  });

  it("treats names that differ only in case as the same file", () => {
    const used = new Set<string>();
    expect(uniqueName("A.jpg", used)).toBe("A.jpg");
    expect(uniqueName("a.jpg", used)).toBe("a (2).jpg");
    expect(uniqueName("A.JPG", used)).toBe("A (3).JPG");
  });

  it("skips a numbered name that is already taken in another case", () => {
    const used = new Set<string>();
    uniqueName("a (2).jpg", used);
    uniqueName("a.jpg", used);
    expect(uniqueName("A.jpg", used)).toBe("A (3).jpg");
  });

  it("numbers a dotfile after the whole name", () => {
    const used = new Set<string>();
    expect(uniqueName(".x", used)).toBe(".x");
    expect(uniqueName(".x", used)).toBe(".x (2)");
  });
});
