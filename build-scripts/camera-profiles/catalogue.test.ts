// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// From every DCP found to what ships: only profiles tagged "allow copying",
// grouped by camera whatever Adobe's casing, each camera's measured baseline,
// and the notice that keeps Adobe's copyright with them.

import { describe, expect, it } from "vitest";
import { parseDcp } from "./dcp.ts";
import { buildCatalogue, slug, stableJson, type Baselines } from "./catalogue.ts";
import { buildDcp, type DcpFixture } from "./fixtures.test-support.ts";

const dcp = (path: string, f: DcpFixture) => ({ path, dcp: parseDcp(buildDcp(f)) });

const NIKON: Baselines = {
  "Nikon Z 6 2": {
    baselineExposure: 0.2,
    iso: 100,
    make: "NIKON CORPORATION",
    model: "NIKON Z 6_2",
    source: "library",
    converter: "test",
  },
};

describe("buildCatalogue", () => {
  it("groups a camera's profiles whatever Adobe's casing, spelled as its first file has it", () => {
    const { index, files } = buildCatalogue(
      [
        dcp("Camera/Pentax K-1/Pentax K-1 Camera Standard.dcp", { model: "Pentax K-1", name: "Camera Standard" }),
        dcp("Adobe Standard/PENTAX K-1 Adobe Standard.dcp", { model: "PENTAX K-1", name: "Adobe Standard" }),
      ],
      {},
      "test",
    );
    expect(Object.keys(index.models)).toEqual(["PENTAX K-1"]);
    expect(index.models["PENTAX K-1"].profiles).toEqual(["Adobe Standard", "Camera Standard"]);
    expect(files.get("pentax-k-1.slcp")?.map((p) => p.name)).toEqual(["Adobe Standard", "Camera Standard"]);
  });

  it("ships only profiles tagged allow copying, and no camera left without one", () => {
    const { index, files } = buildCatalogue(
      [
        dcp("Adobe Standard/Nikon D3400 Adobe Standard.dcp", { model: "Nikon D3400", name: "Adobe Standard" }),
        dcp("Camera/Nikon D3400/Nikon D3400 Camera Standard.dcp", { model: "Nikon D3400", name: "Camera Standard", policy: 1 }),
        dcp("Camera/Sony A/Sony A Camera Standard.dcp", { model: "Sony A", name: "Camera Standard", policy: 1 }),
        dcp("Adobe Standard/Untagged Adobe Standard.dcp", { model: "Untagged", name: "Adobe Standard", policy: null }),
      ],
      {},
      "test",
    );
    expect(Object.keys(index.models)).toEqual(["Nikon D3400"]);
    expect(index.models["Nikon D3400"].profiles).toEqual(["Adobe Standard"]);
    expect([...files.values()].flat().every((p) => p.embedPolicy === 0)).toBe(true);
  });

  it("carries each camera's measured baseline and EXIF names, and null for the rest", () => {
    const { index } = buildCatalogue(
      [
        dcp("Camera/Nikon Z 6 2/Nikon Z 6 2 Camera Standard.dcp", { model: "Nikon Z 6 2", name: "Camera Standard" }),
        dcp("Adobe Standard/Nikon D3400 Adobe Standard.dcp", { model: "Nikon D3400", name: "Adobe Standard" }),
      ],
      NIKON,
      "Adobe Camera Raw profiles",
    );
    expect(index.format).toBe(1);
    expect(index.source).toBe("Adobe Camera Raw profiles");
    expect(index.models["Nikon Z 6 2"]).toEqual({
      exif: [["NIKON CORPORATION", "NIKON Z 6_2"]],
      baselineExposure: 0.2,
      baselineIso: 100,
      file: "nikon-z-6-2.slcp",
      profiles: ["Camera Standard"],
    });
    expect(index.models["Nikon D3400"]).toMatchObject({ exif: [], baselineExposure: null, baselineIso: null });
  });

  it("lists the unmeasured cameras, those with camera styles first", () => {
    const { unmeasured } = buildCatalogue(
      [
        dcp("Adobe Standard/A Adobe Standard.dcp", { model: "A", name: "Adobe Standard" }),
        dcp("Camera/B/B Camera Standard.dcp", { model: "B", name: "Camera Standard" }),
        dcp("Camera/Nikon Z 6 2/Nikon Z 6 2 Camera Standard.dcp", { model: "Nikon Z 6 2", name: "Camera Standard" }),
      ],
      NIKON,
      "test",
    );
    expect(unmeasured).toEqual(["B", "A"]);
  });

  it("keeps Adobe's copyright with every camera in the notice", () => {
    const { notice } = buildCatalogue(
      [dcp("Camera/Nikon Z 6 2/x.dcp", { model: "Nikon Z 6 2", name: "Camera Standard", copyright: "Copyright 2018 Adobe Systems, Inc." })],
      {},
      "test",
    );
    expect(notice).toContain("ProfileEmbedPolicy 0");
    expect(notice).toContain("- Nikon Z 6 2: Camera Standard. Copyright 2018 Adobe Systems, Inc.");
  });

  it("gives two cameras whose names make the same slug different files", () => {
    const { index } = buildCatalogue(
      [
        dcp("Adobe Standard/Canon EOS-1D X Adobe Standard.dcp", { model: "Canon EOS-1D X", name: "Adobe Standard" }),
        dcp("Adobe Standard/Canon EOS 1D X Adobe Standard.dcp", { model: "Canon EOS 1D X", name: "Adobe Standard" }),
      ],
      {},
      "test",
    );
    const fileNames = Object.values(index.models).map((m) => m.file);
    expect(new Set(fileNames).size).toBe(2);
  });
});

describe("slug and stableJson", () => {
  it("make a file name from a camera name", () => {
    expect(slug("Nikon Z 6 2")).toBe("nikon-z-6-2");
    expect(slug("OM Digital Solutions OM-1")).toBe("om-digital-solutions-om-1");
  });

  it("write keys in sorted order at every level", () => {
    expect(stableJson({ b: 1, a: { d: [3, { f: 1, e: 2 }], c: null } })).toBe(
      '{\n  "a": {\n    "c": null,\n    "d": [\n      3,\n      {\n        "e": 2,\n        "f": 1\n      }\n    ]\n  },\n  "b": 1\n}\n',
    );
  });
});
