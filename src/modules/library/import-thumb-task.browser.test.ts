// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The import pixel task end to end in Chromium: a real tagged JPEG in, a real
// thumbnail out. Guards the two ways a JPEG's own Orientation tag used to leak
// into the decode — a Fujifilm preview squashed into its sensor-native resize
// box, and a portrait camera JPEG turned twice. Runs from vitest.webgl.config.ts
// (`npm run test:webgl`).

import { describe, expect, it } from "vitest";
import { runThumbTask, type ThumbTaskInput } from "./import-thumb-task";
import { corners, taggedJpeg } from "./tagged-jpeg.test-support";

/** A 64×32 red|blue frame tagged Orientation 6, brought upright: 16×32 at
 *  thumbMaxEdge 32, red on top. */
const UPRIGHT = {
  frame: { width: 32, height: 64 },
  corners: { size: "16x32", topLeft: "red", topRight: "red", bottomLeft: "blue" },
};

async function thumbOf(over: Partial<ThumbTaskInput>) {
  const r = await runThumbTask({
    buffer: (await taggedJpeg(64, 32, 6)).buffer,
    name: "a.RAF",
    type: "",
    lastModified: 1_600_000_000_000,
    orientation: 6,
    previewSource: "auto",
    thumbMaxEdge: 32,
    ...over,
  });
  if (!r.ok) throw new Error("the thumbnail task declined the file");
  return { frame: { width: r.width, height: r.height }, corners: await corners(r.thumb) };
}

describe("runThumbTask in Chromium", () => {
  it("brings a Fujifilm-style tagged preview upright from the master EXIF, unsquashed", async () => {
    expect(await thumbOf({ name: "a.RAF" })).toEqual(UPRIGHT);
  });

  it("turns a portrait camera JPEG exactly once", async () => {
    expect(await thumbOf({ name: "b.jpg", type: "image/jpeg" })).toEqual(UPRIGHT);
  });
});
