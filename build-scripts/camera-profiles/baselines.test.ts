// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A camera's own BaselineExposure lives in Adobe's code, not in any profile;
// it comes out only in a DNG Adobe's converter writes. The tool converts one
// sample per camera and keeps the number. The converter is faked here: it
// writes a small DNG the way the real one would.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { measureSamples, type Converter } from "./baselines.ts";
import type { Baselines } from "./catalogue.ts";
import { buildDng, buildTiff } from "./fixtures.test-support.ts";

let dir: string;
let converted: string[];

const CAMERAS: Record<string, { adobe: string; make: string; model: string; ev: number }> = {
  "z6.NEF": { adobe: "Nikon Z 6 2", make: "NIKON CORPORATION", model: "NIKON Z 6_2", ev: 0.2 },
  "z6-second.NEF": { adobe: "Nikon Z 6 2", make: "NIKON CORPORATION", model: "NIKON Z 6_2", ev: 0.2 },
  "d3400.NEF": { adobe: "Nikon D3400", make: "NIKON CORPORATION", model: "NIKON D3400", ev: 0.35 },
  "xt5.RAF": { adobe: "Fujifilm X-T5", make: "FUJIFILM", model: "X-T5", ev: 0.5 },
};

const fake: Converter = (rawPath, outDir) => {
  const name = path.basename(rawPath);
  converted.push(name);
  const cam = CAMERAS[name];
  if (!cam) throw new Error(`cannot convert ${name}`);
  const dng = path.join(outDir, `${path.parse(name).name}.dng`);
  fs.writeFileSync(dng, buildDng({ model: cam.adobe, baselineExposure: cam.ev, make: cam.make, exifModel: cam.model, iso: 100 }));
  return dng;
};

function sample(name: string): void {
  const cam = CAMERAS[name];
  // A RAF has no TIFF header, so its make and model are known only after converting.
  const bytes = name.endsWith(".RAF")
    ? new TextEncoder().encode("FUJIFILMCCD-RAW 0201")
    : buildTiff([
        { tag: 0x010f, type: 2, values: cam?.make ?? "ACME" },
        { tag: 0x0110, type: 2, values: cam?.model ?? "BROKEN" },
      ]);
  fs.writeFileSync(path.join(dir, name), bytes);
}

/** A RAW whose header names `make` and `model`; what the DNG says is up to the converter. */
function rawFile(name: string, make: string, model: string): void {
  fs.writeFileSync(
    path.join(dir, name),
    buildTiff([
      { tag: 0x010f, type: 2, values: make },
      { tag: 0x0110, type: 2, values: model },
    ]),
  );
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "samples-"));
  converted = [];
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("measureSamples", () => {
  it("records each camera's baseline from one sample, with where it came from", () => {
    sample("z6.NEF");
    sample("d3400.NEF");
    const out = measureSamples(dir, "library", {}, fake, "DNG Converter test");
    expect(out["Nikon Z 6 2"]).toEqual({
      baselineExposure: 0.2,
      iso: 100,
      make: "NIKON CORPORATION",
      model: "NIKON Z 6_2",
      source: "library",
      converter: "DNG Converter test",
    });
    expect(out["Nikon D3400"].baselineExposure).toBe(0.35);
  });

  it("converts no second sample of a camera it already measured", () => {
    sample("z6.NEF");
    sample("z6-second.NEF");
    measureSamples(dir, "library", {}, fake, "test");
    expect(converted).toHaveLength(1);
  });

  it("converts nothing for a camera measured before", () => {
    sample("z6.NEF");
    const before: Baselines = {
      "Nikon Z 6 2": { baselineExposure: 0.2, iso: 100, make: "NIKON CORPORATION", model: "NIKON Z 6_2", source: "library", converter: "old" },
    };
    const out = measureSamples(dir, "library", before, fake, "test");
    expect(converted).toEqual([]);
    expect(out["Nikon Z 6 2"].converter).toBe("old");
  });

  it("converts a RAW whose header it can't read to learn its camera", () => {
    sample("xt5.RAF");
    expect(measureSamples(dir, "test library", {}, fake, "test")["Fujifilm X-T5"].baselineExposure).toBe(0.5);
  });

  it("skips a sample the converter can't convert and goes on", () => {
    sample("broken.NEF");
    sample("z6.NEF");
    const out = measureSamples(dir, "library", {}, fake, "test");
    expect(Object.keys(out)).toEqual(["Nikon Z 6 2"]);
  });

  it("looks in subfolders and ignores files that aren't RAWs", () => {
    fs.mkdirSync(path.join(dir, "2026"));
    fs.writeFileSync(path.join(dir, "notes.txt"), "x");
    sample("d3400.NEF");
    fs.renameSync(path.join(dir, "d3400.NEF"), path.join(dir, "2026", "d3400.NEF"));
    expect(Object.keys(measureSamples(dir, "library", {}, fake, "test"))).toEqual(["Nikon D3400"]);
    expect(converted).toEqual(["d3400.NEF"]);
  });

  it("reports a sample whose conversion fails with the converter's message, and measures the next", () => {
    sample("broken.NEF");
    sample("z6.NEF");
    const reports: [string, string][] = [];
    const out = measureSamples(dir, "library", {}, fake, "test", (file, reason) => reports.push([file, reason]));
    expect(Object.keys(out)).toEqual(["Nikon Z 6 2"]);
    expect(reports).toEqual([[path.join(dir, "broken.NEF"), "cannot convert broken.NEF"]]);
  });

  it("reports a converter that names a DNG which isn't there, and goes on", () => {
    sample("z6.NEF");
    sample("d3400.NEF");
    const missing: Converter = (rawPath, outDir) =>
      rawPath.endsWith("z6.NEF") ? path.join(outDir, "never-written.dng") : fake(rawPath, outDir);
    const reports: [string, string][] = [];
    const out = measureSamples(dir, "library", {}, missing, "test", (file, reason) => reports.push([file, reason]));
    expect(Object.keys(out)).toEqual(["Nikon D3400"]);
    expect(reports.map(([file]) => file)).toEqual([path.join(dir, "z6.NEF")]);
    expect(reports[0][1]).toContain("never-written.dng");
  });

  it("reports a samples folder that doesn't exist and returns the baselines unchanged", () => {
    const before: Baselines = {
      "Nikon Z 6 2": { baselineExposure: 0.2, iso: 100, make: "NIKON CORPORATION", model: "NIKON Z 6_2", source: "library", converter: "old" },
    };
    const missing = path.join(dir, "not-there");
    const reports: [string, string][] = [];
    const out = measureSamples(missing, "library", before, fake, "test", (file, reason) => reports.push([file, reason]));
    expect(out).toEqual(before);
    expect(converted).toEqual([]);
    expect(reports.map(([file]) => file)).toEqual([missing]);
  });

  it("gives up on a camera after three failed conversions, and skips its later files silently", () => {
    const refuses: Converter = (rawPath) => {
      converted.push(path.basename(rawPath));
      throw new Error("refused");
    };
    for (const name of ["f1.NEF", "f2.NEF", "f3.NEF", "f4.NEF", "f5.NEF"]) rawFile(name, "NIKON CORPORATION", "NIKON Z 6_2");
    const reports: [string, string][] = [];
    measureSamples(dir, "library", {}, refuses, "test", (file, reason) => reports.push([file, reason]));
    expect(converted).toHaveLength(3);
    expect(reports).toHaveLength(4);
    expect(reports.filter(([, reason]) => reason.startsWith("giving up"))).toEqual([
      [path.join(dir, "f3.NEF"), "giving up on NIKON CORPORATION NIKON Z 6_2 after 3 failed conversions"],
    ]);
  });

  it("converts a camera once when its DNG names it differently from the RAW header", () => {
    const renamed: Converter = (rawPath, outDir) => {
      converted.push(path.basename(rawPath));
      const dng = path.join(outDir, `${path.parse(rawPath).name}.dng`);
      fs.writeFileSync(
        dng,
        buildDng({ model: "Nikon Z 6 2", baselineExposure: 0.2, make: "NIKON CORPORATION", exifModel: "NIKON Z 6II", iso: 100 }),
      );
      return dng;
    };
    rawFile("r1.NEF", "NIKON CORPORATION", "NIKON Z 6_2");
    rawFile("r2.NEF", "NIKON CORPORATION", "NIKON Z 6_2");
    const out = measureSamples(dir, "library", {}, renamed, "test");
    expect(converted).toHaveLength(1);
    expect(Object.keys(out)).toEqual(["Nikon Z 6 2"]);
  });

  it("reports a DNG with an empty model and records nothing", () => {
    const noModel: Converter = (rawPath, outDir) => {
      const dng = path.join(outDir, `${path.parse(rawPath).name}.dng`);
      fs.writeFileSync(
        dng,
        buildDng({ model: "Nikon Z 6 2", baselineExposure: 0.2, make: "NIKON CORPORATION", exifModel: "   ", iso: 100 }),
      );
      return dng;
    };
    sample("z6.NEF");
    const reports: [string, string][] = [];
    const out = measureSamples(dir, "library", {}, noModel, "test", (file, reason) => reports.push([file, reason]));
    expect(out).toEqual({});
    expect(reports).toEqual([[path.join(dir, "z6.NEF"), "the DNG names no camera model"]]);
  });
});
