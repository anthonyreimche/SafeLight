#!/usr/bin/env node
// Convert Lensfun XML database files into a single lens-profiles.json for
// Safelight. Run with: node scripts/convert-lensfun-db.mjs
//
// Input:  src/lens-profiles/vendor/lensfun-db/*.xml
// Output: public/data/lens-profiles.json

import { readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";

const DB_DIR = join(import.meta.dirname, "..", "src", "lens-profiles", "vendor", "lensfun-db");
const OUT_FILE = join(import.meta.dirname, "..", "public", "data", "lens-profiles.json");

// Tiny XML parser — good enough for Lensfun's simple, well-formed XML.
// No dependencies needed.

function parseXml(xml) {
  const lenses = [];
  const lensBlocks = xml.match(/<lens>[\s\S]*?<\/lens>/g) || [];

  for (const block of lensBlocks) {
    const lens = parseLensBlock(block);
    if (lens) lenses.push(lens);
  }
  return lenses;
}

function parseLensBlock(block) {
  const maker = extractText(block, "maker") || "";
  const model = extractText(block, "model") || "";
  if (!model) return null;

  const mount = extractText(block, "mount") || "";
  const cropStr = extractText(block, "cropfactor");
  const cropFactor = cropStr ? parseFloat(cropStr) : 1;
  const typeStr = extractText(block, "type") || "rectilinear";

  // Focal range from <focal> element or inferred from calibration
  let focalMin = Infinity, focalMax = -Infinity;
  let apertureMin = Infinity, apertureMax = -Infinity;

  const focalEl = block.match(/<focal\s+min="([^"]+)"(?:\s+max="([^"]+)")?/);
  if (focalEl) {
    focalMin = parseFloat(focalEl[1]);
    focalMax = focalEl[2] ? parseFloat(focalEl[2]) : focalMin;
  }

  const apertureEl = block.match(/<aperture\s+min="([^"]+)"(?:\s+max="([^"]+)")?/);
  if (apertureEl) {
    apertureMin = parseFloat(apertureEl[1]);
    apertureMax = apertureEl[2] ? parseFloat(apertureEl[2]) : apertureMin;
  }

  // Parse calibration data
  const distortion = [];
  const tca = [];
  const vignetting = [];

  const distMatches = block.matchAll(/<distortion\s+([^/>]+)\/?>/g);
  for (const m of distMatches) {
    const d = parseDistortion(m[1]);
    if (d) {
      distortion.push(d);
      if (d.focal < focalMin) focalMin = d.focal;
      if (d.focal > focalMax) focalMax = d.focal;
    }
  }

  const tcaMatches = block.matchAll(/<tca\s+([^/>]+)\/?>/g);
  for (const m of tcaMatches) {
    const t = parseTca(m[1]);
    if (t) {
      tca.push(t);
      if (t.focal < focalMin) focalMin = t.focal;
      if (t.focal > focalMax) focalMax = t.focal;
    }
  }

  const vigMatches = block.matchAll(/<vignetting\s+([^/>]+)\/?>/g);
  for (const m of vigMatches) {
    const v = parseVignetting(m[1]);
    if (v) {
      vignetting.push(v);
      if (v.focal < focalMin) focalMin = v.focal;
      if (v.focal > focalMax) focalMax = v.focal;
      if (v.aperture < apertureMin) apertureMin = v.aperture;
      if (v.aperture > apertureMax) apertureMax = v.aperture;
    }
  }

  // Skip lenses with no calibration data at all
  if (distortion.length === 0 && tca.length === 0 && vignetting.length === 0) {
    return null;
  }

  if (!isFinite(focalMin)) focalMin = 0;
  if (!isFinite(focalMax)) focalMax = 0;
  if (!isFinite(apertureMin)) apertureMin = 0;
  if (!isFinite(apertureMax)) apertureMax = 0;

  const id = slugify(`${maker}-${model}`);

  return {
    id,
    maker,
    model,
    mounts: mount ? [mount] : [],
    cropFactor,
    type: typeStr,
    focalMin,
    focalMax,
    apertureMin,
    apertureMax,
    distortion,
    tca,
    vignetting,
  };
}

function parseDistortion(attrs) {
  const model = attr(attrs, "model");
  const focal = parseFloat(attr(attrs, "focal") || "0");
  if (!model) return null;

  let k;
  if (model === "poly3") {
    k = [parseFloat(attr(attrs, "k1") || "0")];
  } else if (model === "poly5") {
    k = [parseFloat(attr(attrs, "k1") || "0"), parseFloat(attr(attrs, "k2") || "0")];
  } else if (model === "ptlens") {
    k = [
      parseFloat(attr(attrs, "a") || "0"),
      parseFloat(attr(attrs, "b") || "0"),
      parseFloat(attr(attrs, "c") || "0"),
    ];
  } else {
    return null;
  }

  return { focal, model, k };
}

function parseTca(attrs) {
  const model = attr(attrs, "model");
  const focal = parseFloat(attr(attrs, "focal") || "0");
  if (!model) return null;

  let k;
  if (model === "linear") {
    k = [
      parseFloat(attr(attrs, "kr") || "1"),
      parseFloat(attr(attrs, "kb") || "1"),
    ];
  } else if (model === "poly3") {
    // Lensfun poly3 TCA uses: br, cr, vr (red channel), bb, cb, vb (blue channel)
    // Many entries only have vr/vb; others have br+vr+bb+vb or all six.
    // Defaults: br=0, cr=0, vr=1, bb=0, cb=0, vb=1
    k = [
      parseFloat(attr(attrs, "br") || "0"),
      parseFloat(attr(attrs, "cr") || "0"),
      parseFloat(attr(attrs, "vr") || "1"),
      parseFloat(attr(attrs, "bb") || "0"),
      parseFloat(attr(attrs, "cb") || "0"),
      parseFloat(attr(attrs, "vb") || "1"),
    ];
  } else {
    return null;
  }

  return { focal, model, k };
}

function parseVignetting(attrs) {
  const model = attr(attrs, "model");
  if (model !== "pa") return null;

  const focal = parseFloat(attr(attrs, "focal") || "0");
  const aperture = parseFloat(attr(attrs, "aperture") || "0");
  const distance = parseFloat(attr(attrs, "distance") || "1000");

  return {
    focal,
    aperture,
    distance,
    k: [
      parseFloat(attr(attrs, "k1") || "0"),
      parseFloat(attr(attrs, "k2") || "0"),
      parseFloat(attr(attrs, "k3") || "0"),
    ],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractText(xml, tag) {
  // Prefer the lang="en" variant if present
  const langMatch = xml.match(new RegExp(`<${tag}\\s+lang="en"[^>]*>([^<]+)</${tag}>`));
  if (langMatch) return langMatch[1].trim();
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]+)</${tag}>`));
  return match ? match[1].trim() : null;
}

function attr(str, name) {
  const m = str.match(new RegExp(`${name}="([^"]+)"`));
  return m ? m[1] : null;
}

function slugify(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const files = readdirSync(DB_DIR).filter((f) => f.endsWith(".xml"));
let allLenses = [];

for (const file of files) {
  const xml = readFileSync(join(DB_DIR, file), "utf-8");
  const lenses = parseXml(xml);
  allLenses.push(...lenses);
}

// Deduplicate by ID (some lenses appear in multiple files)
const seen = new Set();
const deduped = [];
for (const lens of allLenses) {
  if (!seen.has(lens.id)) {
    seen.add(lens.id);
    deduped.push(lens);
  }
}

// Sort by maker, then model
deduped.sort((a, b) => a.maker.localeCompare(b.maker) || a.model.localeCompare(b.model));

writeFileSync(OUT_FILE, JSON.stringify(deduped));

const rawSize = JSON.stringify(deduped).length;
console.log(`Converted ${files.length} XML files -> ${deduped.length} lenses`);
console.log(`Output: ${OUT_FILE} (${(rawSize / 1024).toFixed(0)} KB)`);
