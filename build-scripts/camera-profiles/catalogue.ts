// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What ships, from every DCP the build tool found: only profiles tagged
// ProfileEmbedPolicy 0 ("allow copying"), grouped by camera however Adobe
// cased its name, with each camera's measured BaselineExposure and a notice
// that keeps Adobe's copyright with the tables. Pure, so a rebuild with the
// same inputs gives the same output.

import { CAMERA_PROFILE_FORMAT, type PackableProfile } from "../../src/rendering/camera-profiles/format.ts";
import { normalizeModelKey } from "../../src/rendering/camera-profiles/model-key.ts";
import type { ParsedDcp } from "./dcp.ts";

export interface Baseline {
  baselineExposure: number;
  iso: number | null;
  make: string;
  model: string;
  /** Where the sample came from: "library", "test library", "raw.pixls.us". */
  source: string;
  converter: string;
}

/** Measured cameras, keyed by Adobe's UniqueCameraModel. */
export type Baselines = Record<string, Baseline>;

export interface IndexModel {
  exif: [string, string][];
  baselineExposure: number | null;
  baselineIso: number | null;
  file: string;
  profiles: string[];
}

export interface ProfileIndex {
  format: number;
  source: string;
  models: Record<string, IndexModel>;
}

export interface Catalogue {
  index: ProfileIndex;
  /** File name to the profiles it holds. */
  files: Map<string, PackableProfile[]>;
  notice: string;
  /** Cameras without a measured baseline, those with camera styles first. */
  unmeasured: string[];
}

// Locale-free, so the order doesn't depend on the machine.
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function slug(name: string): string {
  return normalizeModelKey(name).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const shippable = (d: ParsedDcp): boolean => d.embedPolicy === 0 && d.uniqueCameraModel !== "" && d.name !== "";

export function buildCatalogue(
  dcps: readonly { path: string; dcp: ParsedDcp }[],
  baselines: Baselines,
  source: string,
): Catalogue {
  const groups = new Map<string, { path: string; dcp: ParsedDcp }[]>();
  for (const entry of [...dcps].sort((a, b) => byText(a.path, b.path))) {
    if (!shippable(entry.dcp)) continue;
    const key = normalizeModelKey(entry.dcp.uniqueCameraModel);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const measured = new Map(Object.entries(baselines).map(([name, b]) => [normalizeModelKey(name), b]));

  const models: Record<string, IndexModel> = {};
  const files = new Map<string, PackableProfile[]>();
  const lines: string[] = [];
  const withStyles: string[] = [];
  const without: string[] = [];
  for (const key of [...groups.keys()].sort(byText)) {
    const group = groups.get(key) ?? [];
    const name = group[0].dcp.uniqueCameraModel;
    const byName = new Map<string, ParsedDcp>();
    for (const { dcp } of group) if (!byName.has(dcp.name)) byName.set(dcp.name, dcp);
    const profiles = [...byName.values()].sort((a, b) => byText(a.name, b.name));
    let file = `${slug(name)}.slcp`;
    for (let n = 2; files.has(file); n++) file = `${slug(name)}-${n}.slcp`;
    files.set(file, profiles.map(({ uniqueCameraModel: _model, ...p }) => p));
    const b = measured.get(key);
    models[name] = {
      exif: b ? [[b.make, b.model]] : [],
      baselineExposure: b ? b.baselineExposure : null,
      baselineIso: b ? b.iso : null,
      file,
      profiles: profiles.map((p) => p.name),
    };
    const copyrights = [...new Set(profiles.map((p) => p.copyright))].sort(byText).join("; ");
    lines.push(`- ${name}: ${profiles.map((p) => p.name).join(", ")}. ${copyrights}`);
    if (!b) (profiles.some((p) => p.name.startsWith("Camera ")) ? withStyles : without).push(name);
  }

  const notice = [
    "# Adobe camera profiles",
    "",
    "The camera profile tables in this folder are built from Adobe DNG Camera Profiles (DCP)",
    "installed with Adobe Camera Raw. Only profiles tagged ProfileEmbedPolicy 0 (\"allow",
    "copying\") are included, each with Adobe's copyright notice:",
    "",
    ...lines,
    "",
  ].join("\n");
  return {
    index: { format: CAMERA_PROFILE_FORMAT, source, models },
    files,
    notice,
    unmeasured: [...withStyles, ...without],
  };
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => byText(a, b));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortDeep(v)]));
  }
  return value;
}

/** JSON with keys sorted at every level, 2-space indent, a trailing newline. */
export function stableJson(value: unknown): string {
  return `${JSON.stringify(sortDeep(value), null, 2)}\n`;
}
