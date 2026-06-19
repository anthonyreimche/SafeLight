// Parse a Lightroom / Adobe Camera Raw preset (.xmp) into SafeLight develop
// params. Regex-based, mirroring the style of parseXmp() — handles both the
// attribute form (crs:Exposure2012="+1.50") and the element form
// (<crs:Exposure2012>+1.50</crs:Exposure2012>) Lightroom emits across versions.
//
// Only the subset of crs: settings that map cleanly onto SafeLight is read;
// everything else (crop, transform, lens, masks) is left for core's
// normalizeParams() to fill with defaults.

import type {
  DevelopParams,
  HSLChannel,
  ColorGradingRange,
} from "./safelight";

// crs: scalar → DevelopParams numeric key. Lightroom's ranges line up with
// SafeLight's (±100 sliders, exposure in EV, temperature in Kelvin), so values
// pass through unchanged; core clamps anything out of range.
const CRS_SCALAR_MAP: Record<string, keyof DevelopParams> = {
  Exposure2012: "exposure",
  Contrast2012: "contrast",
  Highlights2012: "highlights",
  Shadows2012: "shadows",
  Whites2012: "whites",
  Blacks2012: "blacks",
  Texture: "texture",
  Clarity2012: "clarity",
  Dehaze: "dehaze",
  Vibrance: "vibrance",
  Saturation: "saturation",
  Temperature: "temperature",
  Tint: "tint",
  Sharpness: "sharpening",
  SharpenRadius: "sharpenRadius",
  SharpenDetail: "sharpenDetail",
  SharpenEdgeMasking: "sharpenMasking",
  LuminanceSmoothing: "luminanceNR",
  LuminanceNoiseReductionDetail: "luminanceNRDetail",
  LuminanceNoiseReductionContrast: "luminanceNRContrast",
  ColorNoiseReduction: "colorNR",
  ColorNoiseReductionDetail: "colorNRDetail",
  ColorNoiseReductionSmoothness: "colorNRSmoothness",
};

// Lightroom HSL channel names = SafeLight's, just capitalized.
const HSL_COLORS: { crs: string; ch: HSLChannel }[] = [
  { crs: "Red", ch: "red" },
  { crs: "Orange", ch: "orange" },
  { crs: "Yellow", ch: "yellow" },
  { crs: "Green", ch: "green" },
  { crs: "Aqua", ch: "aqua" },
  { crs: "Blue", ch: "blue" },
  { crs: "Purple", ch: "purple" },
  { crs: "Magenta", ch: "magenta" },
];

function readCrsRaw(xml: string, key: string): string | null {
  const attr = xml.match(new RegExp(`crs:${key}\\s*=\\s*"([^"]*)"`));
  if (attr) return attr[1];
  const el = xml.match(new RegExp(`<crs:${key}>([^<]*)</crs:${key}>`));
  if (el) return el[1];
  return null;
}

function readCrsNum(xml: string, key: string): number | null {
  const raw = readCrsRaw(xml, key);
  if (raw == null) return null;
  const n = parseFloat(raw.trim().replace(/^\+/, ""));
  return Number.isFinite(n) ? n : null;
}

function zeroHSL(): Record<HSLChannel, number> {
  return {
    red: 0, orange: 0, yellow: 0, green: 0,
    aqua: 0, blue: 0, purple: 0, magenta: 0,
  };
}

// Parse a crs tone-curve element (an rdf:Seq of "x, y" pairs in 0..255) into
// SafeLight CurvePoint[] in 0..1. Returns null if the curve is absent/empty.
function parseCurve(xml: string, key: string): { x: number; y: number }[] | null {
  const block = xml.match(new RegExp(`<crs:${key}>([\\s\\S]*?)</crs:${key}>`));
  if (!block) return null;
  const pts: { x: number; y: number }[] = [];
  const liRegex = /<rdf:li>\s*([0-9.]+)\s*,\s*([0-9.]+)\s*<\/rdf:li>/g;
  let m: RegExpExecArray | null;
  while ((m = liRegex.exec(block[1])) !== null) {
    pts.push({ x: parseFloat(m[1]) / 255, y: parseFloat(m[2]) / 255 });
  }
  return pts.length >= 2 ? pts : null;
}

// Build one color-grading range from crs ColorGrade* keys, falling back to the
// older SplitToning* keys when present. Returns null if nothing is set.
function readGradeRange(
  xml: string,
  gradeKey: string,
  splitKey?: string,
): ColorGradingRange | null {
  let hue = readCrsNum(xml, `ColorGrade${gradeKey}Hue`);
  let sat = readCrsNum(xml, `ColorGrade${gradeKey}Sat`);
  const luma = readCrsNum(xml, `ColorGrade${gradeKey}Lum`);
  if ((hue == null || sat == null) && splitKey) {
    hue = hue ?? readCrsNum(xml, `SplitToning${splitKey}Hue`);
    sat = sat ?? readCrsNum(xml, `SplitToning${splitKey}Saturation`);
  }
  if (hue == null && sat == null && luma == null) return null;
  return { hue: hue ?? 0, sat: sat ?? 0, luma: luma ?? 0 };
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function readPresetName(xml: string): string | null {
  // <crs:Name><rdf:Alt><rdf:li xml:lang="x-default">My Preset</rdf:li>…
  const alt = xml.match(/<crs:Name>[\s\S]*?<rdf:li[^>]*>([^<]+)<\/rdf:li>/);
  if (alt) return unescapeXml(alt[1].trim());
  const plain = readCrsRaw(xml, "Name");
  return plain ? unescapeXml(plain.trim()) : null;
}

/** Parse a Lightroom/ACR .xmp preset. Returns null if it has no recognizable
 *  crs: develop settings. */
export function parseLightroomXmp(
  xml: string,
  fallbackName = "Imported preset",
): { name: string; params: Partial<DevelopParams> } | null {
  if (!xml.includes("crs:")) return null;

  const params: Partial<DevelopParams> = {};

  // Scalars
  for (const [crsKey, paramKey] of Object.entries(CRS_SCALAR_MAP)) {
    const n = readCrsNum(xml, crsKey);
    if (n != null) (params as Record<string, unknown>)[paramKey] = n;
  }

  // HSL — three bands × eight colors
  const hue = zeroHSL();
  const saturation = zeroHSL();
  const luminance = zeroHSL();
  let hslTouched = false;
  for (const { crs, ch } of HSL_COLORS) {
    const h = readCrsNum(xml, `HueAdjustment${crs}`);
    const s = readCrsNum(xml, `SaturationAdjustment${crs}`);
    const l = readCrsNum(xml, `LuminanceAdjustment${crs}`);
    if (h != null) { hue[ch] = h; hslTouched = true; }
    if (s != null) { saturation[ch] = s; hslTouched = true; }
    if (l != null) { luminance[ch] = l; hslTouched = true; }
  }
  if (hslTouched) params.hsl = { hue, saturation, luminance };

  // Tone curves (Process 2012)
  const rgb = parseCurve(xml, "ToneCurvePV2012");
  const red = parseCurve(xml, "ToneCurvePV2012Red");
  const green = parseCurve(xml, "ToneCurvePV2012Green");
  const blue = parseCurve(xml, "ToneCurvePV2012Blue");
  if (rgb || red || green || blue) {
    const identity = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
    params.toneCurve = {
      rgb: rgb ?? identity,
      red: red ?? identity,
      green: green ?? identity,
      blue: blue ?? identity,
    };
  }

  // Color grading (best-effort: ColorGrade*, SplitToning* fallback)
  const shadows = readGradeRange(xml, "Shadow", "Shadow");
  const midtones = readGradeRange(xml, "Midtone");
  const highlights = readGradeRange(xml, "Highlight", "Highlight");
  const global = readGradeRange(xml, "Global");
  if (shadows || midtones || highlights || global) {
    const zero: ColorGradingRange = { hue: 0, sat: 0, luma: 0 };
    params.colorGrading = {
      shadows: shadows ?? zero,
      midtones: midtones ?? zero,
      highlights: highlights ?? zero,
      global: global ?? zero,
      shadowRange: 50,
      highlightRange: 50,
    };
  }

  if (Object.keys(params).length === 0) return null;
  return { name: readPresetName(xml) ?? fallbackName, params };
}
