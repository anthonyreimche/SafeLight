// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// An export that can't make a renderer reads no photo, and leaves no kept
// original (a library source's) held. Holding each photo's original while the
// export reads and draws it is pinned in export-image.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto } from "@/catalog/types";

const h = vi.hoisted(() => ({ held: [] as unknown[][], released: 0 }));

vi.mock("@/project/library-sources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/project/library-sources")>()),
  holdSourceOriginals: (handles: unknown[]) => {
    h.held.push([...handles]);
    return () => {
      h.released++;
    };
  },
}));
vi.mock("@/rendering/webgl/renderer", () => ({
  WebGLRenderer: class {
    constructor() {
      throw new Error("no graphics here");
    }
  },
}));

import { renderPhotosToBlobs } from "./export-image";

const photo = (id: string): CatalogPhoto => ({
  id,
  filename: `${id}.NEF`,
  relPath: `Trip/${id}.NEF`,
  folder: "Trip",
  directoryHandle: null,
  fileHandle: { kind: "file", name: `${id}.NEF` } as unknown as FileSystemFileHandle,
  thumbnailBlob: null,
  thumbnailUrl: null,
  width: 6000,
  height: 4000,
  fileSize: 4,
  mimeType: "",
  rating: 0,
  colorLabel: "none",
  flag: "none",
  rotation: 0,
  keywords: [],
  dateCreated: 0,
  dateImported: 0,
  exif: {},
});

beforeEach(() => {
  h.held = [];
  h.released = 0;
  vi.stubGlobal("document", { createElement: () => ({}) });
});

afterEach(() => vi.unstubAllGlobals());

describe("an export's originals", () => {
  it("are left alone, and none stays held, when no renderer can be made", async () => {
    const photos = [photo("a"), photo("b")];
    vi.spyOn(console, "error").mockImplementation(() => {});
    await renderPhotosToBlobs(photos, { format: "image/jpeg", quality: 0.9, longEdge: null, bundle: false, delivery: "files" });
    expect(h.released).toBe(h.held.length);
  });
});
