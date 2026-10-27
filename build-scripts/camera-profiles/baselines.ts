// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A camera's own BaselineExposure (Lightroom's hidden per-model exposure) is in
// no profile file; Adobe's DNG Converter writes it into the DNGs it makes. So
// the build tool converts one sample RAW per camera and keeps the number in
// baselines.local.json (git-ignored: they are Adobe's calibration data). A RAW
// whose header already names a measured camera isn't converted.
//
// The samples folder is a mixed bag of files this tool doesn't control, so one
// bad file is reported and skipped; it never ends the run.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { modelKey, normalizeModelKey } from "../../src/rendering/camera-profiles/model-key.ts";
import type { Baselines } from "./catalogue.ts";
import { readDngFacts, readMakeModel } from "./dng-tags.ts";

export const RAW_EXTENSIONS: ReadonlySet<string> = new Set([
  ".3fr", ".ari", ".arw", ".cr2", ".cr3", ".crw", ".dcr", ".dng", ".erf", ".fff", ".iiq", ".k25", ".kdc",
  ".mef", ".mos", ".mrw", ".nef", ".nrw", ".orf", ".ori", ".pef", ".raf", ".raw", ".rw2", ".rwl", ".sr2",
  ".srf", ".srw", ".x3f",
]);

/** Converts one RAW into `outDir` and returns the DNG's path; throws when it made none. */
export type Converter = (rawPath: string, outDir: string) => string;

/** Told about each sample or folder skipped, and why. */
export type OnSkip = (file: string, reason: string) => void;

// A healthy conversion takes seconds; past two minutes the converter is hung.
const CONVERTER_TIMEOUT_MS = 120000;

// Each retry is a full converter run, so a camera failing this often is given up on.
const MAX_FAILED_CONVERSIONS = 3;

/** Adobe DNG Converter: compressed, no preview. It exits 0 even when it fails,
 *  so the DNG's existence is the answer. */
export function dngConverter(exe: string): Converter {
  return (rawPath, outDir) => {
    execFileSync(exe, ["-c", "-p0", "-d", outDir, rawPath], { stdio: "ignore", timeout: CONVERTER_TIMEOUT_MS });
    const dng = path.join(outDir, `${path.parse(rawPath).name}.dng`);
    if (!fs.existsSync(dng)) throw new Error(`the converter made no DNG for ${rawPath}`);
    return dng;
  };
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function* walk(dir: string, onSkip: OnSkip): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    onSkip(dir, `unreadable folder: ${message(e)}`);
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full, onSkip);
    else if (RAW_EXTENSIONS.has(path.extname(e.name).toLowerCase())) yield full;
  }
}

/** The first megabyte: enough for a RAW's IFD0. */
function head(file: string): Uint8Array {
  const fd = fs.openSync(file, "r");
  try {
    const buf = new Uint8Array(1 << 20);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

/** `baselines` with every camera found under `dir` that it lacked. Each sample
 *  that can't be measured goes to `onSkip` with the reason, and the run goes on. */
export function measureSamples(
  dir: string,
  label: string,
  baselines: Baselines,
  convert: Converter,
  converterName: string,
  onSkip: OnSkip = () => {},
): Baselines {
  const out: Baselines = { ...baselines };
  const seen = new Set(Object.values(out).map((b) => modelKey(b.make, b.model)));
  const failed = new Map<string, number>();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safelight-camera-profiles-"));
  try {
    for (const raw of walk(dir, onSkip)) {
      // The camera the RAW's header names. RAFs and CR3s name none until converted,
      // so their failures can't be counted against a camera.
      let header: { key: string; name: string } | undefined;
      try {
        const named = readMakeModel(head(raw));
        const key = named ? modelKey(named.make, named.model) : undefined;
        if (named && key) header = { key, name: `${named.make} ${named.model}`.trim() };
        if (header && (seen.has(header.key) || (failed.get(header.key) ?? 0) >= MAX_FAILED_CONVERSIONS)) continue;
        const dng = convert(raw, tmp);
        const bytes = fs.readFileSync(dng);
        fs.rmSync(dng, { force: true });
        const facts = readDngFacts(new Uint8Array(bytes));
        if (!facts) throw new Error("the DNG holds no camera facts");
        if (facts.model.trim() === "") throw new Error("the DNG names no camera model");
        if (header) seen.add(header.key);
        seen.add(modelKey(facts.make, facts.model));
        const known = Object.keys(out).some((name) => normalizeModelKey(name) === normalizeModelKey(facts.uniqueCameraModel));
        if (known) continue;
        out[facts.uniqueCameraModel] = {
          baselineExposure: Math.round(facts.baselineExposure * 1000) / 1000,
          iso: facts.iso,
          make: facts.make,
          model: facts.model,
          source: label,
          converter: converterName,
        };
      } catch (e) {
        onSkip(raw, message(e));
        if (!header) continue;
        const count = (failed.get(header.key) ?? 0) + 1;
        failed.set(header.key, count);
        if (count === MAX_FAILED_CONVERSIONS) {
          onSkip(raw, `giving up on ${header.name} after ${MAX_FAILED_CONVERSIONS} failed conversions`);
        }
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return out;
}
