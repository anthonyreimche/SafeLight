// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import {
  DEFAULT_DEVELOP_PARAMS,
  assignDevelopParam,
  type DevelopParams,
} from "@/catalog/types";
import { useRegistry } from "@/extensions/registry";
import { getAllDescriptors } from "@/extensions/param-registry";

// Per-panel preview-off ("bypass"): the develop renderer neutralizes a held
// panel's contribution so the user can see the image without it. View-only and
// momentary — it never touches the stored edit or history, so values survive.
//
// Three mechanisms cover every panel:
//  • Owned params — the DevelopParams keys the panel declares
//    (PanelContribution.owns), or for an Essential's panel that doesn't declare
//    them yet, the keys listed below by panel id. They are reset to their
//    factory defaults. Nested params (vignette, grain, hsl, …) reset as whole
//    sub-objects; arrays (masks, retouch) reset to []. The renderer re-derives
//    all of its uniforms/textures from these each frame, so clearing them is a
//    complete, side-effect-free bypass (no shader change).
//  • Owned bag keys — the param-bag keys the panel declares
//    (PanelContribution.ownsBag), for an extension whose stages serve several
//    panels. `bypassParamBag` drops just those, exact or by "prefix.".
//  • Stage params — for every panel that owns neither. Its effect
//    comes from GPU processing stage(s); `bypassParamBag` drops the owning
//    extension's stage params from the contributed bag, so the renderer binds
//    each uniform's declared default (renderer.ts: `?? b.default`) — the
//    stage's neutral state. Its stages' texture values (coverage, paint,
//    atlas), which have no uniform, are dropped with them. No worker change.
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

/** The DevelopParams keys previewing `panelId` off resets: its `owns`, else
 *  the list's. */
const panelOwnedParams = (
  panelId: string,
  state: RegistryState,
): readonly (keyof DevelopParams)[] | undefined =>
  state.panels[panelId]?.owns ?? PANEL_BYPASS_PARAM_KEYS[panelId];

// Return a copy of `params` with every bypassed panel's owned keys reset to
// factory defaults. Returns the same object when no bypassed panel owns any
// (cheap no-op for the common case).
export function applyPanelBypass(
  params: DevelopParams,
  bypassed: Record<string, boolean>,
  state: RegistryState = useRegistry.getState(),
): DevelopParams {
  const keys = Object.keys(bypassed)
    .filter((id) => bypassed[id])
    .flatMap((id) => panelOwnedParams(id, state) ?? []);
  if (keys.length === 0) return params;
  const next = { ...params };
  for (const k of keys) {
    assignDevelopParam(next, k, structuredClone(DEFAULT_DEVELOP_PARAMS[k]));
  }
  return next;
}

/** Whether bag key `k` is one of `ownsBag`'s: an exact key, or under a
 *  prefix ending in ".". */
const inOwnsBag = (ownsBag: readonly string[], k: string): boolean =>
  ownsBag.some((o) => k === o || (o.endsWith(".") && k.startsWith(o)));

// Return a copy of the contributed (extension stage) param bag, view values
// included, without what bypassed panels own there: the keys a panel's
// `ownsBag` names, or, for a panel that owns neither DevelopParams nor bag
// keys, every stage param of its extension, so the renderer falls back to each
// uniform's declared default and each texture value's empty one. Returns the
// same object when no bypassed panel owns anything in the bag.
export function bypassParamBag(
  bag: Record<string, unknown>,
  bypassed: Record<string, boolean>,
  state: RegistryState = useRegistry.getState(),
): Record<string, unknown> {
  const owners = new Set<string>();
  const ownedKeys: string[] = [];
  for (const id of Object.keys(bypassed)) {
    const panel = state.panels[id];
    if (!bypassed[id] || !panel) continue;
    if (panel.ownsBag) ownedKeys.push(...panel.ownsBag);
    else if (!panelOwnedParams(id, state)?.length) owners.add(panel.extensionId);
  }
  if (owners.size === 0 && ownedKeys.length === 0) return bag;
  const descriptors = getAllDescriptors();
  const stagePrefixes = Object.values(state.processingStages)
    .filter((st) => owners.has(st.extensionId))
    .map((st) => `${st.id}.`);
  const ownedByExtension = (k: string): boolean => {
    if (owners.size === 0) return false;
    const d = descriptors.get(k);
    return d ? owners.has(d.extensionId) : stagePrefixes.some((pre) => k.startsWith(pre));
  };
  const owned = (k: string): boolean => inOwnsBag(ownedKeys, k) || ownedByExtension(k);
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(bag)) {
    if (owned(k)) {
      changed = true; // drop -> renderer binds the uniform default (neutral)
      continue;
    }
    next[k] = v;
  }
  return changed ? next : bag;
}

// Whether a panel has something the renderer can preview off: owned params or
// bag keys, or an owning extension that registers at least one GPU processing
// stage. Panels with no previewable effect (Histogram, Edit, Presets) return
// false so the eye is hidden there.
export function panelIsPreviewable(
  panelId: string,
  state: RegistryState,
): boolean {
  if (panelOwnedParams(panelId, state)?.length) return true;
  const ownsBag = state.panels[panelId]?.ownsBag;
  if (ownsBag) return ownsBag.length > 0;
  const ext = state.panels[panelId]?.extensionId;
  if (!ext) return false;
  return Object.values(state.processingStages).some(
    (st) => st.extensionId === ext,
  );
}
