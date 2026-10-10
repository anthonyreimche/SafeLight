// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A float decode that produces no image says why, so its callers know whether
// trying again could ever help, and in what words. libraw is faked; the in-house fallback is the
// real one, and it can't read these bytes either.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DecodeFailure } from "./decode";

const libraw = vi.hoisted(() => ({
  answer: { failure: "unsupported", reason: "imageData returned undefined" } as DecodeFailure,
}));

vi.mock("./libraw-wasm-adapter", () => ({
  decodeRawFloatViaLibRaw: async () => libraw.answer,
}));

import { decodeRawToFloat } from "./decode";
import { PHOTOMETRIC_CFA, TIFF_TAG } from "./tiff";
import { TYPE, buildTiff, field } from "./tiff.test-support";

const notTiff = () => new Blob(["not a TIFF stream"]);

/** A CFA raw whose sensor data is compressed (lossless JPEG, as in NEF, ARW
 *  and CR2): the in-house decoder reads its layout but not its samples. */
function compressedRaw(): Blob {
  return new Blob([
    buildTiff([
      {
        fields: [
          field(TIFF_TAG.PhotometricInterpretation, TYPE.SHORT, PHOTOMETRIC_CFA),
          field(TIFF_TAG.ImageWidth, TYPE.LONG, 4),
          field(TIFF_TAG.ImageLength, TYPE.LONG, 4),
          field(TIFF_TAG.BitsPerSample, TYPE.SHORT, 14),
          field(TIFF_TAG.Compression, TYPE.SHORT, 7),
        ],
      },
    ]),
  ]);
}

beforeEach(() => {
  libraw.answer = { failure: "unsupported", reason: "imageData returned undefined" };
});

describe("decodeRawToFloat failures", () => {
  it("calls a file unsupported when libraw read it to no use and the fallback can't", async () => {
    expect(await decodeRawToFloat(notTiff())).toEqual({
      failure: "unsupported",
      reason: "imageData returned undefined",
    });
  });

  it("calls it transient when libraw couldn't run, though the fallback can't read it", async () => {
    libraw.answer = { failure: "transient", reason: "decode pool unavailable" };

    expect(await decodeRawToFloat(notTiff())).toEqual({
      failure: "transient",
      reason: "decode pool unavailable",
    });
  });

  // The common case: a NEF, ARW or CR2 while libraw can't run here.
  it("keeps libraw's verdict and reason for a compressed raw the fallback can't take", async () => {
    libraw.answer = { failure: "transient", reason: "no Worker support" };
    expect(await decodeRawToFloat(compressedRaw())).toEqual({
      failure: "transient",
      reason: "no Worker support",
    });

    libraw.answer = { failure: "unsupported", reason: "imageData returned undefined" };
    expect(await decodeRawToFloat(compressedRaw())).toEqual({
      failure: "unsupported",
      reason: "imageData returned undefined",
    });
  });

  it("calls it transient when the file can't be read right now", async () => {
    const file = notTiff();
    vi.spyOn(file, "arrayBuffer").mockRejectedValue(new DOMException("busy", "NotReadableError"));

    expect(await decodeRawToFloat(file)).toEqual({
      failure: "transient",
      reason: "couldn't read the file",
    });
  });
});
