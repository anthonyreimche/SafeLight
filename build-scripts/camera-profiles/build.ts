// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Packs the DNG camera profiles of an Adobe Camera Raw install into
// Safelight's camera profile tables (.slcp), keeping only those tagged "allow
// copying", plus each camera's BaselineExposure measured from sample RAWs
// through Adobe's DNG Converter. The tables are local research output: the
// DNG specification limits Adobe's profiles to processing DNG files, so they
// must not ship with the app.
//
//   node --experimental-strip-types build-scripts/camera-profiles/build.ts \
//     --adobe "C:\ProgramData\Adobe\CameraRaw\CameraProfiles" \
//     [--label library --samples <folder> ...] [--dng-converter <exe>] \
//     [--out build-scripts/camera-profiles/out] [--source "Adobe Camera Raw profiles"]
//
// See README.md beside this file.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";
import { packCameraProfiles } from "../../src/rendering/camera-profiles/format.ts";
import { dngConverter, measureSamples, type Converter, type OnSkip } from "./baselines.ts";
import { buildCatalogue, stableJson, type Baselines, type Catalogue } from "./catalogue.ts";
import { parseDcp, type ParsedDcp } from "./dcp.ts";

export interface BuildOptions {
  /** Adobe's CameraProfiles folder (holds Camera/ and Adobe Standard/). */
  adobe: string;
  out: string;
  /** Measured baselines are Adobe's calibration data, so the default file is
   *  git-ignored. A missing file means nothing has been measured yet. */
  baselinesFile: string;
  /** The folder that ships with the app; `out` may not be inside it. Defaults
   *  to this repo's public/. */
  publicDir?: string;
  source: string;
  samples: { dir: string; label: string }[];
  /** null: no converter here (Linux), so only baselines already measured count. */
  converter: Converter | null;
  converterName: string;
  /** Told about each DCP or sample skipped, and why. Defaults to a warning on
   *  the console, so a real run says why a file didn't count. */
  onSkip?: OnSkip;
}

const REPO_PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../public");

const DEFAULT_CONVERTER = "C:\\Program Files\\Adobe\\Adobe DNG Converter\\Adobe DNG Converter.exe";

const warnSkip: OnSkip = (file, reason) => console.warn(`[camera-profiles] skipped ${file}: ${reason}`);

function* dcpFiles(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* dcpFiles(full);
    else if (e.name.toLowerCase().endsWith(".dcp")) yield full;
  }
}

/** True when `child` is `parent` or lies beneath it. path.relative compares
 *  case-insensitively on Windows, where one folder has many spellings. */
function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Runs before anything is read or written. */
function checkOut(out: string, publicDir: string): void {
  if (isWithin(publicDir, out)) {
    throw new Error(`--out ${out}: anything under public/ ships with the app, and Adobe's profiles may only process DNG files`);
  }
  // build() clears `out`, so it has to be a previous output or hold nothing.
  if (fs.existsSync(out) && fs.readdirSync(out).length > 0 && !fs.existsSync(path.join(out, "index.json"))) {
    throw new Error(`--out ${out} holds files that aren't camera profile tables; refusing to clear it`);
  }
}

/** Parses every DCP under `adobe`, measures any samples, writes `out` from
 *  scratch and the updated baselines. */
export function build(opts: BuildOptions): Catalogue {
  checkOut(opts.out, opts.publicDir ?? REPO_PUBLIC);
  const onSkip = opts.onSkip ?? warnSkip;

  const dcps: { path: string; dcp: ParsedDcp }[] = [];
  for (const file of dcpFiles(opts.adobe)) {
    try {
      dcps.push({ path: path.relative(opts.adobe, file).split(path.sep).join("/"), dcp: parseDcp(new Uint8Array(fs.readFileSync(file))) });
    } catch (err) {
      onSkip(file, err instanceof Error ? err.message : String(err));
    }
  }

  let baselines: Baselines = fs.existsSync(opts.baselinesFile) ? JSON.parse(fs.readFileSync(opts.baselinesFile, "utf8")) : {};
  for (const { dir, label } of opts.samples) {
    if (!opts.converter) {
      onSkip(dir, "no DNG Converter here, so its samples are not measured");
      continue;
    }
    baselines = measureSamples(dir, label, baselines, opts.converter, opts.converterName, onSkip);
  }
  fs.writeFileSync(opts.baselinesFile, stableJson(baselines));

  const catalogue = buildCatalogue(dcps, baselines, opts.source);
  // A wrong --adobe folder (or one holding only profiles that can't be copied)
  // would otherwise wipe the good tables below and write an empty index.
  if (Object.keys(catalogue.index.models).length === 0) {
    throw new Error(
      `no DCPs tagged "allow copying" found under ${opts.adobe}; ` +
        `the existing tables in ${opts.out} were left as they were`,
    );
  }
  fs.rmSync(opts.out, { recursive: true, force: true });
  fs.mkdirSync(opts.out, { recursive: true });
  for (const [file, profiles] of [...catalogue.files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    fs.writeFileSync(path.join(opts.out, file), zlib.gzipSync(packCameraProfiles(profiles), { level: 9 }));
  }
  fs.writeFileSync(path.join(opts.out, "index.json"), stableJson(catalogue.index));
  fs.writeFileSync(path.join(opts.out, "NOTICE.md"), catalogue.notice);
  return catalogue;
}

export function parseArgs(argv: string[]): BuildOptions {
  const opts: BuildOptions = {
    adobe: "",
    out: "build-scripts/camera-profiles/out",
    baselinesFile: "build-scripts/camera-profiles/baselines.local.json",
    source: "Adobe Camera Raw profiles",
    samples: [],
    converter: null,
    converterName: "Adobe DNG Converter",
  };
  let label = "samples";
  let converterPath = fs.existsSync(DEFAULT_CONVERTER) ? DEFAULT_CONVERTER : "";
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1] ?? "";
    switch (argv[i]) {
      case "--adobe": opts.adobe = value; i++; break;
      case "--out": opts.out = value; i++; break;
      case "--baselines": opts.baselinesFile = value; i++; break;
      case "--source": opts.source = value; i++; break;
      case "--label": label = value; i++; break;
      case "--samples": opts.samples.push({ dir: value, label }); i++; break;
      case "--dng-converter":
        if (!fs.existsSync(value)) throw new Error(`--dng-converter ${value}: no such file`);
        converterPath = value;
        i++;
        break;
      default: throw new Error(`unknown argument ${argv[i]}`);
    }
  }
  if (!opts.adobe) throw new Error("--adobe <CameraProfiles folder> is required");
  opts.converter = converterPath ? dngConverter(converterPath) : null;
  return opts;
}

function main(argv: string[]): void {
  const catalogue = build(parseArgs(argv));
  const models = Object.keys(catalogue.index.models).length;
  const profiles = [...catalogue.files.values()].reduce((n, p) => n + p.length, 0);
  console.log(`[camera-profiles] ${models} cameras, ${profiles} profiles`);
  if (catalogue.unmeasured.length > 0) {
    console.log(`[camera-profiles] ${catalogue.unmeasured.length} cameras have no measured baseline; first 40:`);
    for (const name of catalogue.unmeasured.slice(0, 40)) console.log(`  ${name}`);
  }
}

// Node resolves the main module to its real path, so a link to this folder
// (junction, symlink, subst drive) must be resolved before comparing.
const entry = process.argv[1];
if (entry && fs.existsSync(entry) && import.meta.url === pathToFileURL(fs.realpathSync(entry)).href) {
  main(process.argv.slice(2));
}
