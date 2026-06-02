export interface CatalogPhoto {
  id: string;
  filename: string;
  directoryHandle: FileSystemDirectoryHandle | null;
  fileHandle: FileSystemFileHandle | null;
  thumbnailBlob: Blob | null;
  thumbnailUrl: string | null;
  width: number;
  height: number;
  fileSize: number;
  mimeType: string;
  rating: number;
  colorLabel: ColorLabel;
  flag: FlagStatus;
  rotation: number; // baked-in display rotation, degrees CW (0/90/180/270)
  keywords: string[];
  dateCreated: number;
  dateImported: number;
  exif: ExifData;
}

export type ColorLabel = "none" | "red" | "yellow" | "green" | "blue" | "purple";
export type FlagStatus = "none" | "pick" | "reject";

export interface ExifData {
  cameraMake?: string;
  cameraModel?: string;
  lens?: string;
  focalLength?: number;
  aperture?: number;
  shutterSpeed?: string;
  iso?: number;
  dateTimeOriginal?: string;
  orientation?: number; // EXIF Orientation tag (1..8)
}

export interface Collection {
  id: string;
  name: string;
  type: "regular" | "smart";
  photoIds: string[];
  criteria?: SmartCriteria;
  dateCreated: number;
}

export interface SmartCriteria {
  rules: SmartRule[];
  match: "all" | "any";
}

export interface SmartRule {
  field: "rating" | "colorLabel" | "flag" | "keyword" | "camera" | "date";
  operator: "is" | "isNot" | "greaterThan" | "lessThan" | "contains";
  value: string | number;
}

export interface EditState {
  photoId: string;
  stack: EditSnapshot[];
  currentIndex: number;
}

export interface EditSnapshot {
  timestamp: number;
  label: string;
  params: DevelopParams;
}

export interface CurvePoint {
  x: number; // 0..1 input
  y: number; // 0..1 output
}

export const TONE_CURVE_CHANNELS = ["rgb", "red", "green", "blue"] as const;
export type ToneCurveChannel = (typeof TONE_CURVE_CHANNELS)[number];

export interface ToneCurves {
  rgb: CurvePoint[]; // master curve, applied to all channels first
  red: CurvePoint[];
  green: CurvePoint[];
  blue: CurvePoint[];
}

export interface CropRect {
  x: number; // 0..1 left edge, image space (y-down, 0 = top)
  y: number; // 0..1 top edge
  width: number; // 0..1 fraction of image width
  height: number; // 0..1 fraction of image height
}

export const HSL_CHANNELS = [
  "red",
  "orange",
  "yellow",
  "green",
  "aqua",
  "blue",
  "purple",
  "magenta",
] as const;

export type HSLChannel = (typeof HSL_CHANNELS)[number];
export type HSLBand = "hue" | "saturation" | "luminance";

export type HSLValues = Record<HSLChannel, number>;

export interface HSLAdjustments {
  hue: HSLValues;
  saturation: HSLValues;
  luminance: HSLValues;
}

// Geometry/perspective transform applied to the whole image before the crop.
// All values are -100..100 with 0 = no effect.
export interface TransformParams {
  perspectiveV: number; // vertical keystone (tilt top/bottom)
  perspectiveH: number; // horizontal keystone (tilt left/right)
  aspect: number; // horizontal vs vertical stretch
  scale: number; // zoom in/out
  offsetX: number; // pan
  offsetY: number;
}

export interface ColorGradingRange {
  hue: number;  // 0..360 degrees
  sat: number;  // 0..100
  luma: number; // -100..100
}

export interface ColorGradingParams {
  shadows: ColorGradingRange;
  midtones: ColorGradingRange;
  highlights: ColorGradingRange;
  global: ColorGradingRange;
  shadowRange: number;    // 0..100: how far shadow wheel extends upward
  highlightRange: number; // 0..100: how far highlight wheel extends downward
}

export interface LensCorrectionParams {
  distortion: number;          // -100..100 (neg=barrel fix, pos=pincushion fix)
  chromaticAberration: number; // 0..100 lateral CA removal
  defringe: number;            // 0..100 fringe suppression amount
  vignetting: number;          // -100..100 lens vignetting correction
}

export interface VignetteParams {
  amount: number;      // -100..100 (neg=darken, pos=lighten edges)
  midpoint: number;    // 0..100 how far the effect reaches in
  roundness: number;   // -100..100 (neg=rectangular, pos=circular)
  feather: number;     // 0..100 edge softness
  highlights: number;  // 0..100 highlight priority (protect highlights)
}

export interface GrainParams {
  amount: number;     // 0..100
  size: number;       // 25..100 grain clumpiness
  roughness: number;  // 0..100 regularity
}

export interface DevelopParams {
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  texture: number;
  clarity: number;
  dehaze: number;
  sharpening: number;        // 0..100 capture sharpening amount
  sharpenRadius: number;     // 1..3   sharpening radius
  sharpenDetail: number;     // 0..100 halo suppression (higher = more detail)
  sharpenMasking: number;    // 0..100 edge masking (0 = sharpen all, 100 = edges only)
  luminanceNR: number;       // 0..100 luminance noise reduction
  luminanceNRDetail: number; // 0..100 luminance detail preservation
  luminanceNRContrast: number; // 0..100 luminance contrast preservation
  colorNR: number;           // 0..100 color (chroma) noise reduction
  colorNRDetail: number;     // 0..100 color detail preservation
  colorNRSmoothness: number; // 0..100 color smoothness
  vibrance: number;
  saturation: number;
  temperature: number;
  tint: number;
  straighten: number; // degrees, -45..45 (0 = none)
  crop: CropRect;
  transform: TransformParams;
  toneCurve: ToneCurves;
  hsl: HSLAdjustments;
  colorGrading: ColorGradingParams;
  lensCorrection: LensCorrectionParams;
  vignette: VignetteParams;
  grain: GrainParams;
}

export const DEFAULT_TRANSFORM: TransformParams = {
  perspectiveV: 0,
  perspectiveH: 0,
  aspect: 0,
  scale: 0,
  offsetX: 0,
  offsetY: 0,
};

export const DEFAULT_TONE_CURVE: CurvePoint[] = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];

export function defaultToneCurves(): ToneCurves {
  return {
    rgb: [...DEFAULT_TONE_CURVE],
    red: [...DEFAULT_TONE_CURVE],
    green: [...DEFAULT_TONE_CURVE],
    blue: [...DEFAULT_TONE_CURVE],
  };
}

export const DEFAULT_CROP: CropRect = { x: 0, y: 0, width: 1, height: 1 };

function defaultColorGradingRange(): ColorGradingRange {
  return { hue: 0, sat: 0, luma: 0 };
}

export function defaultColorGrading(): ColorGradingParams {
  return {
    shadows: defaultColorGradingRange(),
    midtones: defaultColorGradingRange(),
    highlights: defaultColorGradingRange(),
    global: defaultColorGradingRange(),
    shadowRange: 50,
    highlightRange: 50,
  };
}

function zeroHSLValues(): HSLValues {
  return {
    red: 0,
    orange: 0,
    yellow: 0,
    green: 0,
    aqua: 0,
    blue: 0,
    purple: 0,
    magenta: 0,
  };
}

export function defaultHSL(): HSLAdjustments {
  return {
    hue: zeroHSLValues(),
    saturation: zeroHSLValues(),
    luminance: zeroHSLValues(),
  };
}

export const DEFAULT_LENS_CORRECTION: LensCorrectionParams = {
  distortion: 0,
  chromaticAberration: 0,
  defringe: 0,
  vignetting: 0,
};

export const DEFAULT_VIGNETTE: VignetteParams = {
  amount: 0,
  midpoint: 50,
  roundness: 0,
  feather: 50,
  highlights: 0,
};

export const DEFAULT_GRAIN: GrainParams = {
  amount: 0,
  size: 25,
  roughness: 50,
};

export const DEFAULT_DEVELOP_PARAMS: DevelopParams = {
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  texture: 0,
  clarity: 0,
  dehaze: 0,
  sharpening: 25,
  sharpenRadius: 1.0,
  sharpenDetail: 25,
  sharpenMasking: 0,
  luminanceNR: 0,
  luminanceNRDetail: 50,
  luminanceNRContrast: 0,
  colorNR: 25,
  colorNRDetail: 50,
  colorNRSmoothness: 50,
  vibrance: 0,
  saturation: 0,
  temperature: 6500, // Kelvin; 6500 = neutral
  tint: 0,
  straighten: 0,
  crop: { ...DEFAULT_CROP },
  transform: { ...DEFAULT_TRANSFORM },
  toneCurve: defaultToneCurves(),
  hsl: defaultHSL(),
  colorGrading: defaultColorGrading(),
  lensCorrection: { ...DEFAULT_LENS_CORRECTION },
  vignette: { ...DEFAULT_VIGNETTE },
  grain: { ...DEFAULT_GRAIN },
};

function normalizeTransform(
  t: Partial<TransformParams> | undefined,
): TransformParams {
  const c = (n: unknown) =>
    typeof n === "number" && isFinite(n) ? Math.max(-100, Math.min(100, n)) : 0;
  return {
    perspectiveV: c(t?.perspectiveV),
    perspectiveH: c(t?.perspectiveH),
    aspect: c(t?.aspect),
    scale: c(t?.scale),
    offsetX: c(t?.offsetX),
    offsetY: c(t?.offsetY),
  };
}

function clampStraighten(n: number): number {
  if (!isFinite(n)) return 0;
  return Math.min(45, Math.max(-45, n));
}

// Temperature is Kelvin (2000-50000), 6500 neutral. Pre-Kelvin edits stored a
// relative value near 0, so anything below 1000 is treated as "neutral".
function normalizeTemp(n: unknown): number {
  if (typeof n !== "number" || !isFinite(n) || n < 1000) return 6500;
  return Math.min(50000, Math.max(2000, n));
}

function clampTint(n: unknown): number {
  if (typeof n !== "number" || !isFinite(n)) return 0;
  return Math.min(150, Math.max(-150, n));
}

function normalizeCrop(c: Partial<CropRect> | undefined): CropRect {
  if (!c) return { ...DEFAULT_CROP };
  const clamp01 = (n: unknown, d: number) =>
    typeof n === "number" && isFinite(n) ? Math.min(1, Math.max(0, n)) : d;
  const x = clamp01(c.x, 0);
  const y = clamp01(c.y, 0);
  return {
    x,
    y,
    width: Math.max(0.01, Math.min(clamp01(c.width, 1), 1 - x)),
    height: Math.max(0.01, Math.min(clamp01(c.height, 1), 1 - y)),
  };
}

function normalizeColorGradingRange(
  r: Partial<ColorGradingRange> | undefined,
): ColorGradingRange {
  const clamp = (v: unknown, lo: number, hi: number, d: number) =>
    typeof v === "number" && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
  return {
    hue: clamp(r?.hue, 0, 360, 0),
    sat: clamp(r?.sat, 0, 100, 0),
    luma: clamp(r?.luma, -100, 100, 0),
  };
}

function normalizeColorGrading(
  cg: Partial<ColorGradingParams> | undefined,
): ColorGradingParams {
  const clamp01 = (v: unknown, d: number) =>
    typeof v === "number" && isFinite(v) ? Math.min(100, Math.max(0, v)) : d;
  return {
    shadows: normalizeColorGradingRange(cg?.shadows),
    midtones: normalizeColorGradingRange(cg?.midtones),
    highlights: normalizeColorGradingRange(cg?.highlights),
    global: normalizeColorGradingRange(cg?.global),
    shadowRange: clamp01(cg?.shadowRange, 50),
    highlightRange: clamp01(cg?.highlightRange, 50),
  };
}

function normalizeCurve(c: CurvePoint[] | undefined): CurvePoint[] {
  return c && c.length >= 2
    ? c.map((pt) => ({ x: pt.x, y: pt.y }))
    : [...DEFAULT_TONE_CURVE];
}

// Accepts the current object shape or a legacy single-curve array (treated as
// the RGB master curve), so old snapshots/presets still load.
function normalizeToneCurves(tc: unknown): ToneCurves {
  if (Array.isArray(tc)) {
    return { ...defaultToneCurves(), rgb: normalizeCurve(tc as CurvePoint[]) };
  }
  const t = (tc ?? {}) as Partial<ToneCurves>;
  return {
    rgb: normalizeCurve(t.rgb),
    red: normalizeCurve(t.red),
    green: normalizeCurve(t.green),
    blue: normalizeCurve(t.blue),
  };
}

function normalizeLensCorrection(
  lc: Partial<LensCorrectionParams> | undefined,
): LensCorrectionParams {
  const c100 = (v: unknown, d: number) =>
    typeof v === "number" && isFinite(v) ? Math.min(100, Math.max(-100, v)) : d;
  const c0100 = (v: unknown, d: number) =>
    typeof v === "number" && isFinite(v) ? Math.min(100, Math.max(0, v)) : d;
  return {
    distortion: c100(lc?.distortion, 0),
    chromaticAberration: c0100(lc?.chromaticAberration, 0),
    defringe: c0100(lc?.defringe, 0),
    vignetting: c100(lc?.vignetting, 0),
  };
}

function normalizeVignette(
  v: Partial<VignetteParams> | undefined,
): VignetteParams {
  const c = (val: unknown, lo: number, hi: number, d: number) =>
    typeof val === "number" && isFinite(val) ? Math.min(hi, Math.max(lo, val)) : d;
  return {
    amount: c(v?.amount, -100, 100, 0),
    midpoint: c(v?.midpoint, 0, 100, 50),
    roundness: c(v?.roundness, -100, 100, 0),
    feather: c(v?.feather, 0, 100, 50),
    highlights: c(v?.highlights, 0, 100, 0),
  };
}

function normalizeGrain(
  g: Partial<GrainParams> | undefined,
): GrainParams {
  const c = (val: unknown, lo: number, hi: number, d: number) =>
    typeof val === "number" && isFinite(val) ? Math.min(hi, Math.max(lo, val)) : d;
  return {
    amount: c(g?.amount, 0, 100, 0),
    size: c(g?.size, 25, 100, 25),
    roughness: c(g?.roughness, 0, 100, 50),
  };
}

// Merge a (possibly partial / legacy) params object with current defaults so
// snapshots saved before a field existed still load cleanly.
export function normalizeParams(p: Partial<DevelopParams> | undefined): DevelopParams {
  const base = { ...DEFAULT_DEVELOP_PARAMS, ...p };
  return {
    ...base,
    straighten:
      typeof p?.straighten === 'number' ? clampStraighten(p.straighten) : 0,
    temperature: normalizeTemp(p?.temperature),
    tint: clampTint(p?.tint),
    crop: normalizeCrop(p?.crop),
    transform: normalizeTransform(p?.transform),
    toneCurve: normalizeToneCurves(p?.toneCurve),
    hsl: {
      hue: { ...zeroHSLValues(), ...p?.hsl?.hue },
      saturation: { ...zeroHSLValues(), ...p?.hsl?.saturation },
      luminance: { ...zeroHSLValues(), ...p?.hsl?.luminance },
    },
    colorGrading: normalizeColorGrading(p?.colorGrading),
    lensCorrection: normalizeLensCorrection(p?.lensCorrection),
    vignette: normalizeVignette(p?.vignette),
    grain: normalizeGrain(p?.grain),
  };
}

export type SortField = 'dateImported' | 'dateCreated' | 'filename' | 'rating';
export type SortDirection = 'asc' | 'desc';
export type ViewMode = 'grid' | 'list';
export type AppModule = 'library' | 'develop' | 'loupe' | 'export';
