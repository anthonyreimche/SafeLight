// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { DevelopParams } from "@/catalog/types";

const PRESET_FORMAT = "safelight-preset";
const PRESET_VERSION = 1;

// Runtime kind each DevelopParams key must match to survive import. Scalar keys
// carry a raw number that normalizeParams spreads straight through, so a
// mistyped value (e.g. a string) would otherwise reach the renderer as a NaN
// uniform. Complex keys are re-validated field-by-field by normalizeParams; here
// we only gate that the container is the right shape ("object" covers arrays).
const PARAM_KINDS: Record<keyof DevelopParams, "number" | "string" | "object"> = {
  exposure: "number",
  contrast: "number",
  highlights: "number",
  shadows: "number",
  highlightDetail: "number",
  shadowDetail: "number",
  whites: "number",
  blacks: "number",
  texture: "number",
  clarity: "number",
  dehaze: "number",
  sharpening: "number",
  sharpenRadius: "number",
  sharpenDetail: "number",
  sharpenMasking: "number",
  luminanceNR: "number",
  luminanceNRDetail: "number",
  luminanceNRContrast: "number",
  luminanceNRShadows: "number",
  luminanceNRHighlights: "number",
  colorNR: "number",
  colorNRDetail: "number",
  colorNRSmoothness: "number",
  vibrance: "number",
  saturation: "number",
  temperature: "number",
  tint: "number",
  straighten: "number",
  crop: "object",
  transform: "object",
  uprightMode: "string",
  guidedLines: "object",
  toneCurve: "object",
  hsl: "object",
  colorGrading: "object",
  vignette: "object",
  grain: "object",
  masks: "object",
  retouch: "object",
};

// Keep only known DevelopParams keys whose value matches the expected kind, so a
// malformed preset can't inject garbage (or a non-number scalar) into the store.
function sanitizeParams(raw: unknown): Partial<DevelopParams> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const src = raw as Record<string, unknown>;
  const out: Partial<DevelopParams> = {};
  const keep = <K extends keyof DevelopParams>(key: K, value: DevelopParams[K]) => {
    out[key] = value;
  };
  for (const key of Object.keys(PARAM_KINDS) as (keyof DevelopParams)[]) {
    const value = src[key];
    if (value === undefined) continue;
    const kind = PARAM_KINDS[key];
    if (kind === "number" && (typeof value !== "number" || !isFinite(value))) continue;
    if (kind === "string" && typeof value !== "string") continue;
    if (kind === "object" && (typeof value !== "object" || value === null)) continue;
    keep(key, value as DevelopParams[typeof key]);
  }
  return out;
}

interface PresetFile {
  format: string;
  version: number;
  name: string;
  /** Optional group/folder this preset belongs to. */
  group?: string;
  /** Only the adjustments the preset carries (partial presets). */
  params: Partial<DevelopParams>;
  /** Extension-contributed processing-stage params, keyed by qualified key.
   *  Absent when the preset carries no extension-stage adjustments. */
  paramBag?: Record<string, unknown>;
}

// Export the given params as an open, human-readable JSON preset file.
export function exportPreset(
  name: string,
  params: Partial<DevelopParams>,
  group?: string,
  paramBag?: Record<string, unknown>,
) {
  const hasBag = paramBag && Object.keys(paramBag).length > 0;
  const data: PresetFile = {
    format: PRESET_FORMAT,
    version: PRESET_VERSION,
    name,
    group: group?.trim() || undefined,
    params,
    ...(hasBag ? { paramBag } : {}),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${sanitize(name)}.safelight.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// Open a file picker. `accept` is an input `accept` string (e.g.
// ".json,.xmp"). Returns the chosen file, or null if cancelled.
export function pickPresetFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

// Parse a SafeLight preset JSON file. Returns name + group + the partial params
// it carries, or null if the file isn't a SafeLight preset this build can read
// (so the caller can try other importers). Params are kept partial; the caller
// merges them over the photo's current edit when applying.
export async function parseSafelightPreset(file: File): Promise<{
  name: string;
  group?: string;
  params: Partial<DevelopParams>;
  paramBag?: Record<string, unknown>;
} | null> {
  try {
    const parsed = JSON.parse(await file.text()) as Record<string, unknown>;
    if (parsed.format !== PRESET_FORMAT) return null;
    // A future format may respell the keys this build reads, so importing it as
    // v1 would apply a wrong look rather than fail. Anything up to PRESET_VERSION
    // — including a file written before the field existed — still loads.
    if (typeof parsed.version === "number" && parsed.version > PRESET_VERSION) return null;
    const name =
      typeof parsed.name === "string" && parsed.name.trim()
        ? parsed.name
        : file.name.replace(/\.(safelight\.)?json$/i, "");
    const bag = parsed.paramBag;
    return {
      name,
      group: typeof parsed.group === "string" ? parsed.group : undefined,
      params: sanitizeParams(parsed.params),
      paramBag:
        bag && typeof bag === "object" && !Array.isArray(bag)
          ? (bag as Record<string, unknown>)
          : undefined,
    };
  } catch {
    return null;
  }
}

function sanitize(name: string): string {
  const slug = name.replace(/[^a-z0-9-_]+/gi, "-").toLowerCase();
  // A punctuation-only name slugs to separators alone ("///" -> "-"), which is
  // truthy but names the download nothing.
  return /[a-z0-9]/.test(slug) ? slug : "preset";
}
