// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Only the live develop renderer keeps the 8-bit search image (keepSourcePixels),
// and its owner forwards it with sourcePixelsData. The export, histogram and
// thumbnail renderers upload other photos than the one open, so none of them
// may change what the window's source-pixels subscribers see.

import { afterEach, describe, expect, it, vi } from "vitest";
import { onSourcePixels, setSourcePixels, sourcePixels } from "../source-pixels";
import { LINEAR_PROBE_PIPELINE, floatImage, withRenderer } from "./webgl.test-support";

const OPTS = { stages: [], pipeline: LINEAR_PROBE_PIPELINE };
const WHITE = floatImage(4, 4, () => [1, 1, 1]);
const BLACK = floatImage(6, 3, () => [0, 0, 0]);
const OPEN_PHOTO = new Uint8ClampedArray([10, 20, 30, 255]);

afterEach(() => setSourcePixels(new Uint8ClampedArray(0), 0, 0));

describe("a renderer that keeps no source pixels", () => {
  it("leaves the open photo's search image alone on every upload and bind", async () => {
    setSourcePixels(OPEN_PHOTO, 1, 1);
    const listener = vi.fn();
    const stop = onSourcePixels(listener);
    const bitmap = await createImageBitmap(new ImageData(8, 8));
    try {
      withRenderer(OPTS, (r) => {
        expect(r.keepSourcePixels).toBe(false);
        r.setImage(WHITE);
        r.setImage(bitmap);
        r.uploadSource("a", WHITE);
        r.uploadSource("b", BLACK);
        expect(r.bindSource("a")).toBe(true);
        expect(r.sourcePixelsData()).toBeNull();
      });
    } finally {
      bitmap.close();
      stop();
    }
    expect(listener).not.toHaveBeenCalled();
    expect(sourcePixels()).toEqual({ data: OPEN_PHOTO, width: 1, height: 1 });
  });
});

describe("a renderer that keeps source pixels", () => {
  it("hands its owner the bound source's search image, and leaves the module's to the owner", () => {
    setSourcePixels(OPEN_PHOTO, 1, 1);
    withRenderer(OPTS, (r) => {
      r.keepSourcePixels = true;
      r.setImage(WHITE);
      const white = r.sourcePixelsData();
      expect(white).toMatchObject({ w: 4, h: 4 });
      expect(white?.data.every((v) => v === 255)).toBe(true);

      r.uploadSource("a", WHITE);
      r.uploadSource("b", BLACK);
      expect(r.sourcePixelsData()).toMatchObject({ w: 6, h: 3 });
      expect(r.bindSource("a")).toBe(true);
      expect(r.sourcePixelsData()).toMatchObject({ w: 4, h: 4 });
    });
    expect(sourcePixels()).toEqual({ data: OPEN_PHOTO, width: 1, height: 1 });
  });
});
