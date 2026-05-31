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

export interface DevelopParams {
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  clarity: number;
  vibrance: number;
  saturation: number;
  temperature: number;
  tint: number;
  straighten: number; // degrees, -45..45 (0 = none)
  crop: CropRect;
  toneCurve: CurvePoint[];
  hsl: HSLAdjustments;
}

export const DEFAULT_TONE_CURVE: CurvePoint[] = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];

export const DEFAULT_CROP: CropRect = { x: 0, y: 0, width: 1, height: 1 };

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

export const DEFAULT_DEVELOP_PARAMS: DevelopParams = {
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  clarity: 0,
  vibrance: 0,
  saturation: 0,
  temperature: 0,
  tint: 0,
  straighten: 0,
  crop: { ...DEFAULT_CROP },
  toneCurve: [...DEFAULT_TONE_CURVE],
  hsl: defaultHSL(),
};

function clampStraighten(n: number): number {
  if (!isFinite(n)) return 0;
  return Math.min(45, Math.max(-45, n));
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

// Merge a (possibly partial / legacy) params object with current defaults so
// snapshots saved before a field existed still load cleanly.
export function normalizeParams(p: Partial<DevelopParams> | undefined): DevelopParams {
  const base = { ...DEFAULT_DEVELOP_PARAMS, ...p };
  return {
    ...base,
    straighten:
      typeof p?.straighten === "number" ? clampStraighten(p.straighten) : 0,
    crop: normalizeCrop(p?.crop),
    toneCurve:
      p?.toneCurve && p.toneCurve.length >= 2
        ? p.toneCurve.map((pt) => ({ x: pt.x, y: pt.y }))
        : [...DEFAULT_TONE_CURVE],
    hsl: {
      hue: { ...zeroHSLValues(), ...p?.hsl?.hue },
      saturation: { ...zeroHSLValues(), ...p?.hsl?.saturation },
      luminance: { ...zeroHSLValues(), ...p?.hsl?.luminance },
    },
  };
}

export type SortField = "dateImported" | "dateCreated" | "filename" | "rating";
export type SortDirection = "asc" | "desc";
export type ViewMode = "grid" | "list";
export type AppModule = "library" | "develop" | "loupe" | "export";
