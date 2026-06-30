// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { DEFAULT_DEVELOP_PARAMS, type DevelopParams } from "@/catalog/types";
import { useRegistry } from "@/extensions/registry";
import { getAllDescriptors } from "@/extensions/param-registry";

// Per-panel preview-off ("bypass"): the develop renderer neutralizes a held
// panel's contribution so the user can see the image without it. View-only and
// momentary — it never touches the stored edit or history, so values survive.
//
// Two mechanisms cover every panel:
//  • Core panels — keyed by panel id below. The listed DevelopParams keys are
//    reset to their factory defaults. Nested params (vignette, grain, hsl, …)
//    reset as whole sub-objects; arrays (masks, retouch) reset to []. The
//    renderer re-derives all of its uniforms/textures from these each frame, so
//    clearing them is a complete, side-effect-free bypass (no shader change).
//  • Extension panels — not listed here. Their effect comes from GPU processing
//    stage(s); `bypassParamBag` drops the owning extension's stage params from
//    the contributed bag, so the renderer binds each uniform's declared default
//    (renderer.ts: `?? b.default`) — the stage's neutral state. No worker change.
//
// Crop & Straighten and Transform ARE included (people want to see the framed
// vs unframed image). Bypassing Crop shows the full frame; bypassing Transform
// shows the original geometry — and also drops the crop, because the crop rect
// is authored in the *transformed* frame and is meaningless without it, so
// keeping it would reframe the image to garbage. The interactive crop / guided
// overlays are hidden while their panel is held (see DevelopCanvas) so stale
// handles never float over the neutralized image.
export const PANEL_BYPASS_PARAM_KEYS: Record<string, (keyof DevelopParams)[]> = {
  "core.white-balance": ["temperature", "tint"],
  "core.basic": [
    "exposure", "contrast", "highlights", "highlightDetail", "shadows",
    "shadowDetail", "whites", "blacks",
    "texture", "clarity", "dehaze", "vibrance", "saturation",
  ],
  "core.tone-curve": ["toneCurve"],
  "core.color-grading": ["colorGrading"],
  "core.detail": [
    "sharpening", "sharpenRadius", "sharpenDetail", "sharpenMasking",
    "luminanceNR", "luminanceNRDetail", "luminanceNRContrast",
    "luminanceNRShadows", "luminanceNRHighlights",
    "colorNR", "colorNRDetail", "colorNRSmoothness",
  ],
  "core.effects": ["vignette", "grain"],
  "core.hsl": ["hsl"],
  "core.masks": ["masks"],
  "core.retouch": ["retouch"],
  "core.crop": ["crop", "straighten"],
  "core.transform": ["transform", "straighten", "uprightMode", "guidedLines", "crop"],
};

type RegistryState = ReturnType<typeof useRegistry.getState>;

// Return a copy of `params` with every bypassed core panel's keys reset to
// factory defaults. Returns the same object when nothing core is bypassed
// (cheap no-op for the common case).
export function applyPanelBypass(
  params: DevelopParams,
  bypassed: Record<string, boolean>,
): DevelopParams {
  const ids = Object.keys(bypassed).filter(
    (id) => bypassed[id] && PANEL_BYPASS_PARAM_KEYS[id],
  );
  if (ids.length === 0) return params;
  const next = { ...params } as unknown as Record<string, unknown>;
  const defaults = DEFAULT_DEVELOP_PARAMS as unknown as Record<string, unknown>;
  for (const id of ids) {
    for (const k of PANEL_BYPASS_PARAM_KEYS[id]) {
      next[k] = structuredClone(defaults[k]);
    }
  }
  return next as unknown as DevelopParams;
}

// Return a copy of the contributed (extension stage) param bag with every
// bypassed *extension* panel's stage params removed, so the renderer falls back
// to each uniform's declared default. Bypassing any panel an extension owns
// neutralizes all of that extension's stages — the contribution model has no
// panel↔stage link, so the owning extension is the finest grain available.
// Returns the same object when no extension panel is bypassed.
export function bypassParamBag(
  bag: Record<string, unknown>,
  bypassed: Record<string, boolean>,
  state: RegistryState = useRegistry.getState(),
): Record<string, unknown> {
  const ids = Object.keys(bypassed).filter(
    (id) => bypassed[id] && !PANEL_BYPASS_PARAM_KEYS[id],
  );
  if (ids.length === 0) return bag;
  const owners = new Set<string>();
  for (const id of ids) {
    const ext = state.panels[id]?.extensionId;
    if (ext) owners.add(ext);
  }
  if (owners.size === 0) return bag;
  const descriptors = getAllDescriptors();
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(bag)) {
    const d = descriptors.get(k);
    if (d && owners.has(d.extensionId)) {
      changed = true; // drop -> renderer binds the uniform default (neutral)
      continue;
    }
    next[k] = v;
  }
  return changed ? next : bag;
}

// Whether a panel has something the renderer can preview off: a core entry
// above, or (for an extension panel) an owning extension that registers at
// least one GPU processing stage. Panels with no previewable effect (Histogram,
// Edit, Presets) return false so the eye is hidden there.
export function panelIsPreviewable(
  panelId: string,
  state: RegistryState,
): boolean {
  if (PANEL_BYPASS_PARAM_KEYS[panelId]) return true;
  const ext = state.panels[panelId]?.extensionId;
  if (!ext) return false;
  return Object.values(state.processingStages).some(
    (st) => st.extensionId === ext,
  );
}
