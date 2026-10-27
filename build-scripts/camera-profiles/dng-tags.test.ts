// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What the build tool reads back from a DNG Adobe's converter wrote: the
// camera's BaselineExposure (in no profile file) and the EXIF names that tie
// it to a photo; and, to skip measured cameras, a RAW header's Make and Model.

import { describe, expect, it } from "vitest";
import { readDngFacts, readMakeModel } from "./dng-tags.ts";
import { buildDcp, buildDng, buildTiff } from "./fixtures.test-support.ts";

// Points the header's IFD0 offset somewhere else (the fixtures are little-endian).
const withIfdAt = (bytes: Uint8Array, offset: number): Uint8Array => {
  const copy = bytes.slice();
  new DataView(copy.buffer).setUint32(4, offset, true);
  return copy;
};

describe("readDngFacts", () => {
  it("reads the camera, its baseline exposure, its EXIF names and the ISO", () => {
    const dng = buildDng({ model: "Nikon Z 6 2", baselineExposure: 0.2, make: "NIKON CORPORATION", exifModel: "NIKON Z 6_2", iso: 100 });
    expect(readDngFacts(dng)).toEqual({
      uniqueCameraModel: "Nikon Z 6 2",
      baselineExposure: 0.2,
      make: "NIKON CORPORATION",
      model: "NIKON Z 6_2",
      iso: 100,
    });
  });

  it("has no ISO when the DNG records none", () => {
    const dng = buildDng({ model: "Nikon D3400", baselineExposure: 0.35, make: "NIKON CORPORATION", exifModel: "NIKON D3400" });
    expect(readDngFacts(dng)?.iso).toBeNull();
  });

  it("reads nothing from a file that isn't a DNG of a camera", () => {
    expect(readDngFacts(new TextEncoder().encode("not a tiff at all"))).toBeNull();
    expect(readDngFacts(buildDcp({ model: "Nikon Z 6 2", name: "Camera Standard" }))).toBeNull();
    expect(readDngFacts(buildTiff([{ tag: 0x0110, type: 2, values: "NIKON Z 6_2" }]))).toBeNull();
  });

  // The converter writes whole files, so a read that runs off the end is a
  // broken DNG, and no facts come back.
  const withIso = { model: "Nikon Z 6 2", baselineExposure: 0.2, make: "NIKON CORPORATION", exifModel: "NIKON Z 6_2", iso: 100 };

  it("has no facts when the DNG is cut inside IFD0's entry table", () => {
    expect(readDngFacts(buildDng(withIso).subarray(0, 40))).toBeNull();
  });

  it("has no facts when the DNG is cut before its EXIF IFD", () => {
    // IFD0 has five entries, so the EXIF IFD its pointer names starts right after it.
    expect(readDngFacts(buildDng(withIso).subarray(0, 8 + 2 + 5 * 12 + 4))).toBeNull();
  });

  it("has no facts when the DNG is cut inside an out-of-line value", () => {
    const dng = buildDng(withIso);
    expect(readDngFacts(dng.subarray(0, dng.length - 4))).toBeNull();
  });
});

describe("readMakeModel", () => {
  const raw = (magic: number) =>
    buildTiff(
      [
        { tag: 0x010f, type: 2, values: "NIKON CORPORATION" },
        { tag: 0x0110, type: 2, values: "NIKON Z 6_2" },
      ],
      { magic },
    );

  it("reads a TIFF-based RAW's Make and Model", () => {
    expect(readMakeModel(raw(42))).toEqual({ make: "NIKON CORPORATION", model: "NIKON Z 6_2" });
  });

  it("reads Panasonic's and Olympus's TIFF variants", () => {
    for (const magic of [0x55, 0x4f52, 0x5352]) expect(readMakeModel(raw(magic))?.model).toBe("NIKON Z 6_2");
  });

  it("reads nothing from a header it doesn't know", () => {
    expect(readMakeModel(new TextEncoder().encode("FUJIFILMCCD-RAW 0201"))).toBeNull();
  });

  // A RAW is read from its first megabyte, so its IFD0 can be cut anywhere.
  it("returns null when the file is cut inside IFD0's entry table", () => {
    expect(readMakeModel(raw(42).subarray(0, 20))).toBeNull();
  });

  it("returns null when IFD0's offset is past the end of the file", () => {
    expect(readMakeModel(withIfdAt(raw(42), 1000))).toBeNull();
  });

  it("returns null, not a clipped name, when the file is cut inside the Model string", () => {
    const full = raw(42);
    // The Model string is the last thing written, so its first five bytes are "NIKON".
    const modelAt = full.length - "NIKON Z 6_2\0".length;
    expect(readMakeModel(full.subarray(0, modelAt + 5))).toBeNull();
  });

  it("reads the full Make and Model past a large tag the cut leaves out (an RW2's embedded JPEG)", () => {
    // The JPEG's tag sorts after Make and Model, so its bytes are written after
    // theirs and the cut falls only inside the JPEG.
    const rw2 = buildTiff(
      [
        { tag: 0x010f, type: 2, values: "PANASONIC" },
        { tag: 0x0110, type: 2, values: "DC-GH5" },
        { tag: 0x0201, type: 1, values: new Array<number>(5000).fill(0xff) },
      ],
      { magic: 0x55 },
    );
    expect(readMakeModel(rw2.subarray(0, 200))).toEqual({ make: "PANASONIC", model: "DC-GH5" });
  });
});
