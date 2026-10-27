// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// readIfd's two modes: by default a tag whose value runs past the end of the
// file throws, naming the tag; with skipTruncated that tag is left out. An IFD
// whose entry table runs past the end throws in both modes.

import { describe, expect, it } from "vitest";
import { readIfd } from "./tiff.ts";
import { buildTiff } from "./fixtures.test-support.ts";

// IFD0 at 8 with a SHORT (inline) tag and an ASCII tag whose 18 bytes sit at 38..56.
const full = buildTiff([
  { tag: 0x0112, type: 3, values: [7] },
  { tag: 0x010f, type: 2, values: "NIKON CORPORATION" },
]);

describe("readIfd", () => {
  it("reads every tag of a complete IFD", () => {
    expect(readIfd(full, 8, true)).toEqual(
      new Map<number, string | number[]>([
        [0x0112, [7]],
        [0x010f, "NIKON CORPORATION"],
      ]),
    );
  });

  it("throws naming the tag when a string runs past the end of the file", () => {
    expect(() => readIfd(full.subarray(0, 40), 8, true)).toThrow("tag 0x010f runs past the end of the file");
  });

  it("leaves a tag that runs past the end out, keeping the rest, with skipTruncated", () => {
    expect(readIfd(full.subarray(0, 40), 8, true, { skipTruncated: true })).toEqual(new Map([[0x0112, [7]]]));
  });

  it("throws in both modes when the entry table itself runs past the end", () => {
    expect(() => readIfd(full.subarray(0, 20), 8, true)).toThrow("IFD at 8 runs past the end of the file");
    expect(() => readIfd(full.subarray(0, 20), 8, true, { skipTruncated: true })).toThrow(
      "IFD at 8 runs past the end of the file",
    );
  });
});
