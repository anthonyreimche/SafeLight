// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The RAW cache key of a catalogue photo. A photo in a folder keeps the key it
// always had (existing caches stay valid); a library source's photo is known by
// its source key, so it never takes the decode of another photo that had its
// path and size, and keeps its own through an album move or a rename.

import { describe, expect, it } from "vitest";
import { photoCacheKey } from "./photo-cache-key";

const local = { relPath: "2026/DSCF2946.RAF", fileSize: 31_457_280, rotation: 90 };

describe("photoCacheKey", () => {
  it("keeps a folder photo's key byte for byte", () => {
    expect(photoCacheKey(local)).toBe("v6:2026/DSCF2946.RAF:31457280:90");
    expect(photoCacheKey({ relPath: "a.NEF", fileSize: 7, rotation: 0 })).toBe("v6:a.NEF:7:0");
  });

  it("names a source photo by its source key, not its path", () => {
    const removed = { relPath: "Trip/IMG_1.NEF", fileSize: 4, rotation: 0, sourceKey: "asset-a" };
    const taker = { ...removed, sourceKey: "asset-b" };
    expect(photoCacheKey(taker)).not.toBe(photoCacheKey(removed));
  });

  it("keeps a source photo's key when it moves album or is renamed", () => {
    const before = { relPath: "Trip/IMG_1.NEF", fileSize: 4, rotation: 0, sourceKey: "asset-a" };
    expect(photoCacheKey({ ...before, relPath: "Best/Harbour.NEF" })).toBe(photoCacheKey(before));
  });

  it("still turns with the photo and misses for an original of another size", () => {
    const photo = { relPath: "Trip/IMG_1.NEF", fileSize: 4, rotation: 0, sourceKey: "asset-a" };
    expect(photoCacheKey({ ...photo, rotation: 90 })).not.toBe(photoCacheKey(photo));
    expect(photoCacheKey({ ...photo, fileSize: 5 })).not.toBe(photoCacheKey(photo));
  });

  it("never matches a folder photo's key, whatever its path", () => {
    const source = { relPath: "x", fileSize: 4, rotation: 0, sourceKey: "k" };
    expect(photoCacheKey(source)).not.toBe(photoCacheKey({ relPath: "source/k", fileSize: 4, rotation: 0 }));
    expect(photoCacheKey(source).startsWith("v6:")).toBe(true);
  });
});
