// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import {
  LEGACY_MASK_PANELS,
  MAX_MASKS,
  MAX_RETOUCH,
  type BrushDab,
  type BrushMaskGeo,
  type ColorGradingParams,
  type ColorGradingRange,
  type ColorRangeGeo,
  type CropRect,
  type CurvePoint,
  type DevelopParams,
  type GrainParams,
  type GuidedLine,
  type LinearMaskGeo,
  type LumRangeGeo,
  type Mask,
  type MaskAdjustments,
  type MaskComponent,
  type RadialMaskGeo,
  type RetouchSpot,
  type ToneCurves,
  type TransformParams,
  type UprightMode,
  type VignetteParams,
} from "./develop-params";
import {
  DEFAULT_CROP,
  DEFAULT_DEVELOP_PARAMS,
  DEFAULT_TONE_CURVE,
  NEUTRAL_TEMPERATURE_K,
  defaultToneCurves,
  zeroHSLValues,
} from "./defaults";
import {
  CURRENT_PROCESS_VERSION,
  normalizeProcessVersion,
} from "./process-version";

// Pre-registry saves stored sub-panels as short names; map them to the panel
// ids the same controls register under today.
const LEGACY_MASK_PANEL_IDS: Record<string, string> = {
  basic: "core.basic",
  wb: "core.white-balance",
  hsl: "core.hsl",
  curve: "core.tone-curve",
  detail: "core.detail",
};

function normalizeTransform(
  t: Partial<TransformParams> | undefined,
): TransformParams {
  const c = (n: unknown) =>
    typeof n === "number" && isFinite(n) ? Math.max(-100, Math.min(100, n)) : 0;
  const cScale = (n: unknown) => {
    if (typeof n !== "number" || !isFinite(n)) return 100;
    if (n < 50) return Math.max(50, Math.min(150, n + 100));
    return Math.max(50, Math.min(150, n));
  };
  return {
    perspectiveV: c(t?.perspectiveV),
    perspectiveH: c(t?.perspectiveH),
    aspect: c(t?.aspect),
    scale: cScale(t?.scale),
    offsetX: c(t?.offsetX),
    offsetY: c(t?.offsetY),
    flipH: t?.flipH === true,
    flipV: t?.flipV === true,
  };
}

const UPRIGHT_MODES: UprightMode[] = ["off", "auto", "level", "vertical", "full", "guided"];

function normalizeUprightMode(m: unknown): UprightMode {
  return typeof m === "string" && UPRIGHT_MODES.includes(m as UprightMode)
    ? (m as UprightMode)
    : "off";
}

function normalizeGuidedLines(lines: unknown): GuidedLine[] {
  if (!Array.isArray(lines)) return [];
  const out: GuidedLine[] = [];
  for (const l of lines) {
    if (!l || typeof l.x1 !== "number") continue;
    const c = (v: unknown) =>
      typeof v === "number" && isFinite(v) ? Math.min(2, Math.max(-1, v)) : 0;
    out.push({ x1: c(l.x1), y1: c(l.y1), x2: c(l.x2), y2: c(l.y2) });
  }
  return out;
}

function clampStraighten(n: number): number {
  if (!isFinite(n)) return 0;
  return Math.min(45, Math.max(-45, n));
}

// Temperature is Kelvin (2000-50000), 6500 neutral. Pre-Kelvin edits stored a
// relative value near 0, so anything below 1000 is treated as "neutral".
function normalizeTemp(n: unknown): number {
  if (typeof n !== "number" || !isFinite(n) || n < 1000) return NEUTRAL_TEMPERATURE_K;
  return Math.min(50000, Math.max(2000, n));
}

function clampTint(n: unknown): number {
  if (typeof n !== "number" || !isFinite(n)) return 0;
  return Math.min(150, Math.max(-150, n));
}

function normalizeCrop(c: Partial<CropRect> | undefined): CropRect {
  if (!c) return { ...DEFAULT_CROP };
  // The crop is stored in TRANSFORMED-frame coordinates: once a perspective /
  // keystone (or scale / offset) transform is applied, the visible frame is no
  // longer the unit square, so a valid crop legitimately extends outside [0,1]
  // (and x/y can go negative). We therefore only reject non-finite garbage and
  // keep the size positive — clamping back into the source [0,1] box here shifts
  // a keystoned crop every time it's reloaded.
  const finite = (n: unknown, d: number) =>
    typeof n === "number" && isFinite(n) ? n : d;
  return {
    x: finite(c.x, 0),
    y: finite(c.y, 0),
    width: Math.max(0.01, finite(c.width, 1)),
    height: Math.max(0.01, finite(c.height, 1)),
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
  if (!c || c.length < 2) return [...DEFAULT_TONE_CURVE];
  const finite01 = (v: unknown): number | null =>
    typeof v === "number" && isFinite(v) ? Math.min(1, Math.max(0, v)) : null;
  const out: CurvePoint[] = [];
  for (const pt of c) {
    const x = finite01(pt?.x);
    const y = finite01(pt?.y);
    if (x === null || y === null) return [...DEFAULT_TONE_CURVE];
    out.push({ x, y });
  }
  return out;
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
    color: c(g?.color, 0, 100, 0),
  };
}

const clampN = (v: unknown, lo: number, hi: number, d: number) =>
  typeof v === "number" && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;

function normalizeMaskAdjustments(
  a: Partial<MaskAdjustments> | undefined,
): MaskAdjustments {
  return {
    exposure: clampN(a?.exposure, -100, 100, 0),
    contrast: clampN(a?.contrast, -100, 100, 0),
    highlights: clampN(a?.highlights, -100, 100, 0),
    shadows: clampN(a?.shadows, -100, 100, 0),
    whites: clampN(a?.whites, -100, 100, 0),
    blacks: clampN(a?.blacks, -100, 100, 0),
    saturation: clampN(a?.saturation, -100, 100, 0),
    vibrance: clampN(a?.vibrance, -100, 100, 0),
    temperature: clampN(a?.temperature, -100, 100, 0),
    tint: clampN(a?.tint, -100, 100, 0),
    texture: clampN(a?.texture, -100, 100, 0),
    clarity: clampN(a?.clarity, -100, 100, 0),
    dehaze: clampN(a?.dehaze, -100, 100, 0),
    sharpness: clampN(a?.sharpness, -100, 100, 0),
  };
}

// Missing => legacy mask saved before sub-panels existed: show all sliders.
// Short pre-registry names map onto their registered panel ids; unrecognized
// ids are kept (their extension may just be disabled), like normalizeParamBag.
function normalizeMaskPanels(p: unknown): string[] {
  if (!Array.isArray(p)) return [...LEGACY_MASK_PANELS];
  const seen = new Set<string>();
  for (const id of p)
    if (typeof id === "string") seen.add(LEGACY_MASK_PANEL_IDS[id] ?? id);
  return [...seen];
}

function normLinear(g: Partial<LinearMaskGeo> | undefined): LinearMaskGeo {
  return {
    x0: clampN(g?.x0, -2, 2, 0.5),
    y0: clampN(g?.y0, -2, 2, 0.2),
    x1: clampN(g?.x1, -2, 2, 0.5),
    y1: clampN(g?.y1, -2, 2, 0.8),
  };
}
function normRadial(g: Partial<RadialMaskGeo> | undefined): RadialMaskGeo {
  return {
    cx: clampN(g?.cx, -2, 2, 0.5),
    cy: clampN(g?.cy, -2, 2, 0.5),
    rx: clampN(g?.rx, 0.001, 4, 0.3),
    ry: clampN(g?.ry, 0.001, 4, 0.3),
    feather: clampN(g?.feather, 0, 1, 0.5),
    angle: clampN(g?.angle, -7, 7, 0),
  };
}
// The tip a stroke-start dab carries: only that dab's is read, and a tip is
// named by a short string; the id of one that is not registered bakes as the disc.
const MAX_TIP_ID_LENGTH = 128;
function strokeBrushTip(d: BrushDab): Pick<BrushDab, "tip"> {
  const named = typeof d.tip === "string" && d.tip.length > 0 && d.tip.length <= MAX_TIP_ID_LENGTH;
  return named ? { tip: d.tip } : {};
}
// Any dab may carry its own turn; one without takes its stroke's.
function dabAngle(d: BrushDab): Pick<BrushDab, "angle"> {
  const turn = typeof d.angle === "number" && Number.isFinite(d.angle) ? d.angle % (2 * Math.PI) : 0;
  return turn !== 0 ? { angle: turn } : {};
}
function normBrush(g: Partial<BrushMaskGeo> | undefined): BrushMaskGeo {
  const dabs = Array.isArray(g?.dabs) ? g!.dabs : [];
  return {
    feather: clampN(g?.feather, 0, 1, 0.5),
    dabs: dabs
      .filter((d): d is BrushDab => !!d && typeof d.x === "number")
      .map((d) => ({
        x: clampN(d.x, -2, 2, 0),
        y: clampN(d.y, -2, 2, 0),
        radius: clampN(d.radius, 0.001, 2, 0.05),
        erase: !!d.erase,
        feather: clampN(d.feather, 0, 1, 0.5),
        opacity: clampN(d.opacity, 0, 1, 1),
        flow: clampN(d.flow, 0, 1, 1),
        ...(d.strokeStart === true ? { strokeStart: true, ...strokeBrushTip(d) } : {}),
        ...dabAngle(d),
      })),
  };
}

function normLumRange(g: Partial<LumRangeGeo> | undefined): LumRangeGeo {
  return {
    lo: clampN(g?.lo, 0, 1, 0),
    hi: clampN(g?.hi, 0, 1, 1),
    loFeather: clampN(g?.loFeather, 0, 1, 0.1),
    hiFeather: clampN(g?.hiFeather, 0, 1, 0.1),
  };
}
function normColorRange(g: Partial<ColorRangeGeo> | undefined): ColorRangeGeo {
  return {
    r: clampN(g?.r, 0, 16, 0.18),
    g: clampN(g?.g, 0, 16, 0.18),
    b: clampN(g?.b, 0, 16, 0.18),
    hueRange: clampN(g?.hueRange, 0, 1, 0.15),
    satRange: clampN(g?.satRange, 0, 1, 0.3),
    smoothness: clampN(g?.smoothness, 0, 1, 0.25),
  };
}

// Build a single component from a (possibly legacy) raw geometry object.
function normComponent(raw: Partial<MaskComponent>, fallbackId: string): MaskComponent | null {
  const kind = raw.kind;
  const base = {
    id: typeof raw.id === "string" ? raw.id : fallbackId,
    mode:
      raw.mode === "subtract"
        ? ("subtract" as const)
        : raw.mode === "intersect"
          ? ("intersect" as const)
          : ("add" as const),
    invert: !!raw.invert,
  };
  if (kind === "linear" && raw.linear)
    return { ...base, kind, linear: normLinear(raw.linear) };
  if (kind === "radial" && raw.radial)
    return { ...base, kind, radial: normRadial(raw.radial) };
  if (kind === "brush")
    return { ...base, kind, brush: normBrush(raw.brush) };
  if (kind === "lumRange")
    return { ...base, kind, lumRange: normLumRange(raw.lumRange) };
  if (kind === "colorRange")
    return { ...base, kind, colorRange: normColorRange(raw.colorRange) };
  return null;
}

// Migrate a legacy single-geometry mask (type + linear/radial/brush at the top
// level) into a one-component mask.
function legacyComponent(raw: Partial<Mask & { type?: string }>, fallbackId: string): MaskComponent | null {
  const t = (raw as { type?: string }).type;
  const r = raw as Partial<Mask> & {
    linear?: LinearMaskGeo;
    radial?: RadialMaskGeo;
    brush?: BrushMaskGeo;
  };
  if (t === "linear" && r.linear)
    return { id: fallbackId, kind: "linear", mode: "add", invert: false, linear: normLinear(r.linear) };
  if (t === "radial" && r.radial)
    return { id: fallbackId, kind: "radial", mode: "add", invert: false, radial: normRadial(r.radial) };
  if (t === "brush")
    return { id: fallbackId, kind: "brush", mode: "add", invert: false, brush: normBrush(r.brush) };
  return null;
}

function normalizeMasks(masks: unknown): Mask[] {
  if (!Array.isArray(masks)) return [];
  const out: Mask[] = [];
  for (const raw of masks as Partial<Mask & { type?: string }>[]) {
    if (!raw) continue;

    // Deterministic position-based fallback ids so normalizing the same saved
    // data twice yields identical output. A time-based id here makes the edit
    // signature change on every call, which retriggers thumbnail rendering (and
    // a full RAW decode) on every poll of the Library's edited-thumbnail sync.
    const maskId = typeof raw.id === "string" ? raw.id : `mask-${out.length}`;

    let components: MaskComponent[] = [];
    if (Array.isArray(raw.components)) {
      components = raw.components
        .map((c, i) => normComponent(c as Partial<MaskComponent>, `${maskId}-c${i}`))
        .filter((c): c is MaskComponent => !!c);
    } else {
      const legacy = legacyComponent(raw, `${maskId}-c0`);
      if (legacy) components = [legacy];
    }
    if (components.length === 0) continue; // no usable geometry — drop

    const m: Mask = {
      id: maskId,
      name: typeof raw.name === "string" ? raw.name : components[0].kind,
      visible: raw.visible !== false, // default visible; only an explicit false mutes
      invert: !!raw.invert,
      opacity: clampN(raw.opacity, 0, 100, 100),
      adj: normalizeMaskAdjustments(raw.adj),
      panels: normalizeMaskPanels(raw.panels),
      components,
    };
    if (raw.hsl) {
      m.hsl = {
        hue: { ...zeroHSLValues(), ...raw.hsl.hue },
        saturation: { ...zeroHSLValues(), ...raw.hsl.saturation },
        luminance: { ...zeroHSLValues(), ...raw.hsl.luminance },
      };
    }
    if (raw.toneCurve) m.toneCurve = normalizeToneCurves(raw.toneCurve);
    // Extension params are preserved verbatim (validation happens at GPU bind
    // time, and an absent extension's values must survive a round-trip).
    if (raw.bag && typeof raw.bag === "object" && !Array.isArray(raw.bag)) {
      const bag = { ...(raw.bag as Record<string, unknown>) };
      if (Object.keys(bag).length > 0) m.bag = bag;
    }
    out.push(m);
    if (out.length >= MAX_MASKS) break;
  }
  return out;
}

function normalizeRetouch(spots: unknown): RetouchSpot[] {
  if (!Array.isArray(spots)) return [];
  const out: RetouchSpot[] = [];
  for (const raw of spots as Partial<RetouchSpot>[]) {
    if (!raw || typeof raw.dstX !== "number") continue;
    const shape = raw.shape === "brush" ? "brush" : "circle";
    const dabs =
      shape === "brush" && Array.isArray(raw.dabs)
        ? raw.dabs
            .filter((d): d is BrushDab => !!d && typeof d.x === "number")
            .map((d) => ({
              x: clampN(d.x, -2, 2, 0),
              y: clampN(d.y, -2, 2, 0),
              radius: clampN(d.radius, 0.001, 2, 0.04),
              erase: !!d.erase,
              feather: clampN(d.feather, 0, 1, 0.5),
              opacity: clampN(d.opacity, 0, 1, 1),
              flow: clampN(d.flow, 0, 1, 1),
            }))
        : undefined;
    out.push({
      id: typeof raw.id === "string" ? raw.id : `spot-${out.length}`,
      shape,
      mode: raw.mode === "clone" ? "clone" : "heal",
      visible: raw.visible !== false,
      dstX: clampN(raw.dstX, -1, 2, 0.5),
      dstY: clampN(raw.dstY, -1, 2, 0.5),
      srcX: clampN(raw.srcX, -1, 2, 0.5),
      srcY: clampN(raw.srcY, -1, 2, 0.5),
      radius: clampN(raw.radius, 0.002, 1, 0.04),
      feather: clampN(raw.feather, 0, 100, 50),
      opacity: clampN(raw.opacity, 0, 100, 100),
      angle: clampN(raw.angle, -Math.PI, Math.PI, 0),
      scale: clampN(raw.scale, 0.25, 4, 1),
      recolorR: clampN(raw.recolorR, -1, 1, 0),
      recolorG: clampN(raw.recolorG, -1, 1, 0),
      recolorB: clampN(raw.recolorB, -1, 1, 0),
      ...(dabs ? { dabs } : {}),
    });
    if (out.length >= MAX_RETOUCH) break;
  }
  return out;
}

function normalizeDisplayTransform(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

// Merge a (possibly partial / legacy) params object with current defaults so
// snapshots saved before a field existed still load cleanly. The process
// version is the exception: a missing one reads as LEGACY_PROCESS_VERSION,
// not as the defaults' current one.
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
    uprightMode: normalizeUprightMode(p?.uprightMode),
    guidedLines: normalizeGuidedLines(p?.guidedLines),
    toneCurve: normalizeToneCurves(p?.toneCurve),
    hsl: {
      hue: { ...zeroHSLValues(), ...p?.hsl?.hue },
      saturation: { ...zeroHSLValues(), ...p?.hsl?.saturation },
      luminance: { ...zeroHSLValues(), ...p?.hsl?.luminance },
    },
    colorGrading: normalizeColorGrading(p?.colorGrading),
    vignette: normalizeVignette(p?.vignette),
    grain: normalizeGrain(p?.grain),
    masks: normalizeMasks(p?.masks),
    retouch: normalizeRetouch(p?.retouch),
    displayTransform: normalizeDisplayTransform(p?.displayTransform),
    processVersion: normalizeProcessVersion(p?.processVersion),
  };
}

/** Params for a photo with no stored edit: today's defaults at the current
 *  process version, with the camera's white balance. */
export function freshParams(asShotTemperature?: number): DevelopParams {
  return normalizeParams({ temperature: asShotTemperature, processVersion: CURRENT_PROCESS_VERSION });
}
