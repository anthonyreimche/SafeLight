// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The Library Info histogram renders on the main thread at a 256 px edge. When
// no grid thumbnail is loaded it falls back to the full photo load, which for
// a RAW is usually the cached develop preview; that must be capped to the
// histogram's edge, not uploaded at the cache's stored size. The renderer is
// faked here (its cap is covered on a real GL context by
// renderer.webgl.test.ts); this pins what the histogram asks of it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto } from "@/catalog/types";
import { normalizeParams } from "@/catalog/types";

const h = vi.hoisted(() => {
  class FakeRenderer {
    static setImageCalls: unknown[][] = [];
    setAsShotTemperature() {}
    setImage(...args: unknown[]) {
      FakeRenderer.setImageCalls.push(args);
    }
    render() {}
    dispose() {}
  }
  return {
    FakeRenderer,
    cached: {
      kind: "float16" as const,
      data: new Uint16Array(4 * 2 * 4),
      width: 4,
      height: 2,
    },
    histogram: { luma: new Uint32Array(256) },
  };
});

vi.mock("./webgl/renderer", () => ({ WebGLRenderer: h.FakeRenderer }));
vi.mock("@/catalog/load-image", () => ({ loadPhotoImage: async () => h.cached }));
vi.mock("@/rendering/histogram", () => ({ computeHistogram: () => h.histogram }));
vi.mock("@/extensions/pipelines", () => ({ setPhotoParams: () => {} }));

import { renderPhotoHistogram } from "./thumbnail-renderer";

function photo(): CatalogPhoto {
  return {
    id: "p1",
    filename: "DSCF0001.RAF",
    relPath: "DSCF0001.RAF",
    folder: "",
    directoryHandle: null,
    fileHandle: null,
    thumbnailBlob: null,
    thumbnailUrl: null,
    width: 6000,
    height: 4000,
    fileSize: 8,
    mimeType: "image/x-fuji-raf",
    rating: 0,
    colorLabel: "none",
    flag: "none",
    rotation: 0,
    keywords: [],
    dateCreated: 0,
    dateImported: 0,
    exif: {},
  };
}

describe("renderPhotoHistogram without a loaded thumbnail", () => {
  beforeEach(() => {
    h.FakeRenderer.setImageCalls = [];
    vi.stubGlobal("document", {
      createElement: () => ({ addEventListener: () => {} }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("caps a cached RAW source to the histogram edge", async () => {
    const result = await renderPhotoHistogram(photo(), normalizeParams({}));
    expect(result).toBe(h.histogram);
    expect(h.FakeRenderer.setImageCalls).toHaveLength(1);
    const [image, ...options] = h.FakeRenderer.setImageCalls[0];
    expect(image).toBe(h.cached);
    expect(options).toEqual([256, false, false, true]);
  });
});
