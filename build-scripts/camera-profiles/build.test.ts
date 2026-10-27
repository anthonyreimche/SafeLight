// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The whole build on a folder laid out like Adobe's CameraProfiles, with
// synthetic DCPs: what it writes, that the app can read it back, and that a
// second run writes the same bytes.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCameraProfiles } from "../../src/rendering/camera-profiles/format.ts";
import { build, parseArgs, type BuildOptions } from "./build.ts";
import { buildDcp, buildDng, buildTiff } from "./fixtures.test-support.ts";

let root: string;

// --experimental-strip-types arrived in Node 22.6; CI's Node 20 can't run the CLI itself.
const [nodeMajor = 0, nodeMinor = 0] = process.versions.node.split(".").map(Number);
const stripsTypes = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 6);
const here = path.dirname(fileURLToPath(import.meta.url));

function write(rel: string, bytes: Uint8Array): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, bytes);
}

const options = (out: string, over: Partial<BuildOptions> = {}): BuildOptions => ({
  adobe: path.join(root, "CameraProfiles"),
  out: path.join(root, out),
  baselinesFile: path.join(root, "baselines.json"),
  source: "Adobe Camera Raw profiles",
  samples: [],
  converter: null,
  converterName: "test",
  ...over,
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "camera-profiles-"));
  fs.writeFileSync(path.join(root, "baselines.json"), "{}\n");
  write(
    "CameraProfiles/Camera/Nikon Z 6 2/Nikon Z 6 2 Camera Standard.dcp",
    buildDcp({ model: "Nikon Z 6 2", name: "Camera Standard", toneCurve: [0, 0, 0.18, 0.514, 1, 1], exposureOffset: -0.35, look: { dims: [2, 2, 1], data: [0, 1, 1, 5, 0.9, 1, -5, 1.1, 1, 0, 1, 0.95] } }),
  );
  write("CameraProfiles/Camera/Nikon Z 6 2/Nikon Z 6 2 Camera Vivid.dcp", buildDcp({ model: "Nikon Z 6 2", name: "Camera Vivid" }));
  write("CameraProfiles/Adobe Standard/Nikon Z 6 2 Adobe Standard.dcp", buildDcp({ model: "Nikon Z 6 2", name: "Adobe Standard", hueSat: { dims: [2, 1, 1], data1: [2, 1, 1, -2, 1.5, 1] } }));
  write("CameraProfiles/Camera/Nikon D3400/Nikon D3400 Camera Standard.dcp", buildDcp({ model: "Nikon D3400", name: "Camera Standard", policy: 1 }));
  write("CameraProfiles/Adobe Standard/Nikon D3400 Adobe Standard.dcp", buildDcp({ model: "Nikon D3400", name: "Adobe Standard" }));
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("build", () => {
  it("writes the index, one table per camera and the notice", () => {
    build(options("out"));
    const out = path.join(root, "out");
    expect(fs.readdirSync(out).sort()).toEqual(["NOTICE.md", "index.json", "nikon-d3400.slcp", "nikon-z-6-2.slcp"]);
    const index = JSON.parse(fs.readFileSync(path.join(out, "index.json"), "utf8"));
    expect(index.models["Nikon Z 6 2"].profiles).toEqual(["Adobe Standard", "Camera Standard", "Camera Vivid"]);
    expect(index.models["Nikon D3400"].profiles).toEqual(["Adobe Standard"]);
  });

  it("writes tables the app reads back", () => {
    build(options("out"));
    const bytes = zlib.gunzipSync(fs.readFileSync(path.join(root, "out", "nikon-z-6-2.slcp")));
    const profiles = parseCameraProfiles(new Uint8Array(bytes));
    const standard = profiles.find((p) => p.name === "Camera Standard");
    expect(standard?.exposureOffset).toBeCloseTo(-0.35, 6);
    expect(standard?.lookDims).toEqual([2, 2, 1]);
    expect(profiles.find((p) => p.name === "Adobe Standard")?.hueSat1.length).toBe(6);
  });

  it("writes the same bytes when run again on the same inputs", () => {
    build(options("first"));
    build(options("second"));
    const names = fs.readdirSync(path.join(root, "first")).sort();
    expect(names).not.toEqual([]);
    expect(fs.readdirSync(path.join(root, "second")).sort()).toEqual(names);
    for (const name of names) {
      expect(fs.readFileSync(path.join(root, "second", name)).equals(fs.readFileSync(path.join(root, "first", name)))).toBe(true);
    }
  });

  it("starts the output over, so a camera Adobe dropped doesn't linger", () => {
    write("out/index.json", new TextEncoder().encode("{}\n"));
    write("out/old-camera.slcp", new Uint8Array([1, 2, 3]));
    build(options("out"));
    expect(fs.existsSync(path.join(root, "out", "old-camera.slcp"))).toBe(false);
  });

  it("refuses to clear an --out that holds something other than camera profile tables", () => {
    write("out/notes.txt", new Uint8Array([1, 2, 3]));
    expect(() => build(options("out"))).toThrow(/holds files that aren't camera profile tables; refusing to clear it/);
    expect(fs.readdirSync(path.join(root, "out"))).toEqual(["notes.txt"]);
    expect(fs.readFileSync(path.join(root, "out", "notes.txt"))).toEqual(Buffer.from([1, 2, 3]));
  });

  it("builds into an --out that exists but is empty", () => {
    fs.mkdirSync(path.join(root, "out"));
    build(options("out"));
    expect(fs.existsSync(path.join(root, "out", "index.json"))).toBe(true);
  });

  it("refuses an --out that is, or is inside, the folder shipped with the app", () => {
    const publicDir = path.join(root, "public");
    write("public/keep.txt", new Uint8Array([9]));
    const baselines = fs.readFileSync(path.join(root, "baselines.json"), "utf8");
    for (const out of ["public", "public/camera-profiles", "public/a/b"]) {
      expect(() => build(options(out, { publicDir }))).toThrow(/anything under public\/ ships with the app/);
    }
    expect(fs.readdirSync(publicDir)).toEqual(["keep.txt"]);
    expect(fs.readFileSync(path.join(root, "baselines.json"), "utf8")).toBe(baselines);
  });

  it("allows a folder whose name only starts like the shipped one", () => {
    build(options("public-extra/out", { publicDir: path.join(root, "public") }));
    expect(fs.existsSync(path.join(root, "public-extra", "out", "index.json"))).toBe(true);
  });

  it.skipIf(process.platform !== "win32")("compares the shipped folder case-insensitively on Windows", () => {
    expect(() => build(options("PUBLIC/camera-profiles", { publicDir: path.join(root, "public") }))).toThrow(/ships with the app/);
  });

  it("measures samples, keeps the baselines and puts them in the index", () => {
    write("samples/z6.NEF", buildTiff([{ tag: 0x010f, type: 2, values: "NIKON CORPORATION" }, { tag: 0x0110, type: 2, values: "NIKON Z 6_2" }]));
    const converter = (_raw: string, outDir: string): string => {
      const dng = path.join(outDir, "z6.dng");
      fs.writeFileSync(dng, buildDng({ model: "Nikon Z 6 2", baselineExposure: 0.2, make: "NIKON CORPORATION", exifModel: "NIKON Z 6_2", iso: 100 }));
      return dng;
    };
    build(options("out", { samples: [{ dir: path.join(root, "samples"), label: "library" }], converter }));
    const baselines = JSON.parse(fs.readFileSync(path.join(root, "baselines.json"), "utf8"));
    expect(baselines["Nikon Z 6 2"]).toMatchObject({ baselineExposure: 0.2, source: "library" });
    const index = JSON.parse(fs.readFileSync(path.join(root, "out", "index.json"), "utf8"));
    expect(index.models["Nikon Z 6 2"]).toMatchObject({ baselineExposure: 0.2, exif: [["NIKON CORPORATION", "NIKON Z 6_2"]] });
  });

  it("starts with no baselines when their file doesn't exist yet, and writes it", () => {
    fs.rmSync(path.join(root, "baselines.json"));
    build(options("out"));
    expect(fs.readFileSync(path.join(root, "baselines.json"), "utf8")).toBe("{}\n");
  });

  it("returns the cameras still without a measured baseline", () => {
    expect(build(options("out")).unmeasured).toEqual(["Nikon Z 6 2", "Nikon D3400"]);
  });

  it("says why a profile or a sample folder was skipped and still builds", () => {
    write("CameraProfiles/Camera/Broken.dcp", new Uint8Array([1, 2, 3, 4]));
    const skipped: [string, string][] = [];
    const converter = (): string => {
      throw new Error("no sample should reach the converter");
    };
    const onSkip = (file: string, reason: string): void => void skipped.push([path.basename(file), reason]);
    const catalogue = build(options("out", { samples: [{ dir: path.join(root, "missing"), label: "library" }], converter, onSkip }));
    expect(skipped.map(([file]) => file)).toEqual(["Broken.dcp", "missing"]);
    expect(skipped.every(([, reason]) => reason !== "")).toBe(true);
    expect(Object.keys(catalogue.index.models).sort()).toEqual(["Nikon D3400", "Nikon Z 6 2"]);
  });

  it("keeps the existing tables when the Adobe folder yields no cameras", () => {
    write("OnlyCopyProtected/Nikon D3400 Camera Standard.dcp", buildDcp({ model: "Nikon D3400", name: "Camera Standard", policy: 1 }));
    write("out/index.json", new TextEncoder().encode("{}\n"));
    write("out/nikon-z-6-2.slcp", new Uint8Array([1, 2, 3]));
    expect(() => build(options("out", { adobe: path.join(root, "OnlyCopyProtected") }))).toThrow(/OnlyCopyProtected.*left as they were/s);
    expect(fs.readFileSync(path.join(root, "out", "nikon-z-6-2.slcp"))).toEqual(Buffer.from([1, 2, 3]));
  });

  it("skips samples, saying so, when there is no converter", () => {
    const skipped: string[] = [];
    build(options("out", { samples: [{ dir: path.join(root, "samples"), label: "library" }], onSkip: (file) => void skipped.push(path.basename(file)) }));
    expect(skipped).toEqual(["samples"]);
  });
});

describe("parseArgs", () => {
  it("writes to a git-ignored folder beside the tool, never under public/", () => {
    const out = path.resolve(parseArgs(["--adobe", "CameraProfiles"]).out);
    expect(out.split(path.sep).slice(-3)).toEqual(["build-scripts", "camera-profiles", "out"]);
  });

  it("keeps measured baselines in a git-ignored file, not one meant for git", () => {
    const file = path.resolve(parseArgs(["--adobe", "CameraProfiles"]).baselinesFile);
    expect(file.split(path.sep).slice(-3)).toEqual(["build-scripts", "camera-profiles", "baselines.local.json"]);
  });
});

describe("the CLI under Node", () => {
  it.skipIf(!stripsTypes)("build.ts runs when started through a link to its folder", () => {
    // Node resolves a main module to its real path, so a junction or symlink
    // (or a subst drive) must not make the script mistake itself for an import.
    const link = path.join(root, "link");
    fs.symlinkSync(here, link, "junction");
    try {
      const run = spawnSync(
        process.execPath,
        ["--experimental-strip-types", path.join(link, "build.ts"), "--adobe", path.join(root, "CameraProfiles"), "--dng-converter", path.join(root, "no-such-converter.exe")],
        { cwd: root, encoding: "utf8" },
      );
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain("no such file");
    } finally {
      fs.unlinkSync(link);
    }
  });

  it.skipIf(!stripsTypes)("build.ts refuses a --dng-converter that isn't there", () => {
    const missing = path.join(root, "no-such-converter.exe");
    const run = spawnSync(
      process.execPath,
      ["--experimental-strip-types", path.join(here, "build.ts"), "--adobe", path.join(root, "CameraProfiles"), "--dng-converter", missing],
      { cwd: root, encoding: "utf8" },
    );
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("no-such-converter.exe");
  });
});
