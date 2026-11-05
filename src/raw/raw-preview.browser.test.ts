// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The embedded-preview extractor against Chromium's real JPEG decoder, which
// applies a JPEG's own EXIF Orientation whatever imageOrientation asks for (see
// sensorNativeJpeg). A preview that carries an Orientation tag — a Fujifilm
// RAF's does, since it holds the file's whole EXIF block — must still decode
// sensor-native and at the SOF header's aspect; otherwise the decode-time
// resize squashes the uprighted frame into the sensor-native box. Runs from
// vitest.webgl.config.ts (`npm run test:webgl`).

import { describe, expect, it } from "vitest";
import { extractRawPreviewDecoded, sensorNativeJpeg } from "./raw-preview";
import { corners, taggedJpeg } from "./tagged-jpeg.test-support";

const SENSOR_NATIVE = { topLeft: "red", topRight: "blue", bottomLeft: "red" };

describe("extractRawPreviewDecoded in Chromium", () => {
  it("decodes a preview carrying its own Orientation tag sensor-native, at the SOF aspect", async () => {
    const preview = await taggedJpeg(64, 32, 6);
    const d = await extractRawPreviewDecoded(new File([preview], "a.RAF"), {
      targetLongEdge: 32,
    });
    expect(d).toMatchObject({ width: 64, height: 32 });
    expect(await corners(d!.bitmap)).toEqual({ size: "32x16", ...SENSOR_NATIVE });
  });

  it("hands out a blob that decodes sensor-native too (the Develop preview path)", async () => {
    const d = await extractRawPreviewDecoded(new File([await taggedJpeg(64, 32, 6)], "a.RAF"));
    expect(await corners(d!.blob)).toEqual({ size: "64x32", ...SENSOR_NATIVE });
  });
});

describe("sensorNativeJpeg in Chromium", () => {
  it("makes the decoder ignore the JPEG's own Orientation tag", async () => {
    const tagged = await taggedJpeg(64, 32, 6);
    // The tagged bytes come back upright: Chromium honours the tag on decode.
    expect((await corners(new Blob([tagged]))).size).toBe("32x64");
    expect(await corners(sensorNativeJpeg(tagged))).toEqual({ size: "64x32", ...SENSOR_NATIVE });
  });
});
