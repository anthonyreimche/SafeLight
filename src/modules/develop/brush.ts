// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The official brush: what every painting tool (Masking, Heal, Paint Layers,
// Lens Blur...) starts with and how the rebindable brush shortcuts
// (Preferences ▸ Shortcuts) change it. A tool holds its own brush; it reads
// the defaults and steps from here (api.develop.brush) so all of them behave
// as one brush does. Size is a radius as a share of the photo's height, as a
// BrushDab's is; the rest run 0 to 1.

export interface BrushSettings {
  size: number;
  feather: number;
  opacity: number;
  flow: number;
}

export type BrushSetting = keyof BrushSettings;

export const BRUSH_DEFAULTS: Readonly<BrushSettings> = Object.freeze({ size: 0.08, feather: 0.5, opacity: 1, flow: 1 });

interface Step {
  key: BrushSetting;
  by: number;
  min: number;
  max: number;
}

const STEPS: Readonly<Record<string, Step>> = {
  "brush.smaller": { key: "size", by: -0.01, min: 0.01, max: 0.5 },
  "brush.larger": { key: "size", by: 0.01, min: 0.01, max: 0.5 },
  "brush.featherDown": { key: "feather", by: -0.05, min: 0, max: 1 },
  "brush.featherUp": { key: "feather", by: 0.05, min: 0, max: 1 },
  "brush.opacityDown": { key: "opacity", by: -0.1, min: 0.01, max: 1 },
  "brush.opacityUp": { key: "opacity", by: 0.1, min: 0.01, max: 1 },
  "brush.flowDown": { key: "flow", by: -0.1, min: 0.01, max: 1 },
  "brush.flowUp": { key: "flow", by: 0.1, min: 0.01, max: 1 },
};

/** The keybinding ids of the brush shortcuts, which only the held canvas
 *  tool acts on. */
export const BRUSH_ACTIONS: readonly string[] = Object.freeze(Object.keys(STEPS));

/** A tool's own limits for a setting, where they differ from the brush's
 *  (red-eye rings run far smaller than a mask brush). */
export type BrushRange = Partial<Record<BrushSetting, { min?: number; max?: number }>>;

/** The setting a brush shortcut changes and its value after the step, held to
 *  its range (the tool's own `range` where given); null for an action that
 *  isn't a brush shortcut, or one for a setting `brush` doesn't have, so a
 *  tool without flow leaves the flow keys alone. A step never moves a setting
 *  the wrong way. A canvas tool answers onAction and wants with it. */
export function stepBrush(
  action: string,
  brush: Partial<BrushSettings>,
  range?: BrushRange,
): { key: BrushSetting; value: number } | null {
  const s = Object.hasOwn(STEPS, action) ? STEPS[action] : undefined;
  const now = s ? brush[s.key] : undefined;
  if (!s || now === undefined) return null;
  const min = range?.[s.key]?.min ?? s.min;
  const max = range?.[s.key]?.max ?? s.max;
  // Rounded to the step's grid, so 0.08 + 0.01 is 0.09 and not 0.09000000000000001.
  const stepped = Math.max(min, Math.min(max, Math.round((now + s.by) * 1000) / 1000));
  return { key: s.key, value: s.by < 0 ? Math.min(now, stepped) : Math.max(now, stepped) };
}
