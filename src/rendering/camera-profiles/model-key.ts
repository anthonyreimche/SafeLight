// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The key a camera is known by in the camera profile tables
// (public/camera-profiles/index.json). Adobe names a camera by its
// UniqueCameraModel, not always consistently ("PENTAX K-1" beside "Pentax K-1
// Mark II", "RICOH GR III"); a photo names it by its EXIF Make and Model
// ("NIKON CORPORATION", "NIKON Z 6_2"). Both reduce to one lowercase key.
// The build tool imports this file directly, so it has no imports.

/** Lowercase, underscores as spaces, single spaces, trimmed. */
export function normalizeModelKey(name: string): string {
  return name.replace(/_/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

// Makers as Adobe names them, found by a word in the EXIF Make or Model. Pentax
// comes first: Pentax bodies report Ricoh as their make and name Pentax in the
// model.
const MAKERS: readonly [RegExp, string][] = [
  [/\bpentax\b/, "pentax"],
  [/\bom digital\b/, "om digital solutions"],
  [/\bnikon\b/, "nikon"],
  [/\bcanon\b/, "canon"],
  [/\bsony\b/, "sony"],
  [/\bpanasonic\b/, "panasonic"],
  [/\bfujifilm\b/, "fujifilm"],
  [/\bolympus\b/, "olympus"],
  [/\bricoh\b/, "ricoh"],
  [/\bleica\b/, "leica"],
  [/\bsigma\b/, "sigma"],
  [/\bhasselblad\b/, "hasselblad"],
  [/\bphase one\b/, "phase one"],
  [/\bkonica minolta\b/, "konica minolta"],
  [/\bminolta\b/, "minolta"],
  [/\bsamsung\b/, "samsung"],
  [/\bkodak\b/, "kodak"],
];

/** The table key for a photo's EXIF Make and Model; undefined without a model.
 *  A maker the table doesn't know keeps the first word of its make. */
export function modelKey(make: string | undefined, model: string | undefined): string | undefined {
  const m = normalizeModelKey(model ?? "");
  if (!m) return undefined;
  const mk = normalizeModelKey(make ?? "");
  const maker = MAKERS.find(([word]) => word.test(`${mk} ${m}`))?.[1] ?? mk.split(" ")[0];
  if (!maker) return m;
  const bare = m.startsWith(`${maker} `) ? m.slice(maker.length + 1) : m;
  return `${maker} ${bare}`;
}
