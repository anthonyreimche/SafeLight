// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// photo-types.json is the one list of photo extensions. The installer's file
// associations in package.json are generated from it by hand, so they are held to it here.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import types from "./photo-types.json";

interface Pkg {
  build: {
    mac: { fileAssociations: { ext: string[]; name: string }[] };
    linux: { mimeTypes: string[] };
  };
}

const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as Pkg;
const bare = (exts: string[]) => exts.map((e) => e.slice(1)).sort();

describe("package.json file associations", () => {
  it("registers the Mac photo and RAW photo types as exactly the standard and raw lists", () => {
    const [photo, raw] = pkg.build.mac.fileAssociations;
    expect([...photo.ext].sort()).toEqual(bare(Object.keys(types.standard)));
    expect([...raw.ext].sort()).toEqual(bare(Object.keys(types.raw)));
  });

  it("registers every known mime type on Linux", () => {
    const known = new Set(
      [...Object.values(types.standard), ...Object.values(types.raw)].filter(
        (m): m is string => m !== null,
      ),
    );
    const missing = [...known].filter((m) => !pkg.build.linux.mimeTypes.includes(m));
    expect(missing).toEqual([]);
  });
});
