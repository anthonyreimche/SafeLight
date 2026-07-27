// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { create } from "zustand";
import type {
  BrushDab,
  CurvePoint,
  DevelopParams,
  EditSnapshot,
  EditState,
  HSLBand,
  HSLChannel,
  Mask,
  MaskAdjustments,
  MaskComponent,
  MaskComponentMode,
  MaskType,
  RetouchSpot,
  ToneCurveChannel,
} from "@/catalog/types";
import {
  MAX_MASKS,
  MAX_RETOUCH,
  defaultColorRange,
  defaultLumRange,
  defaultMaskAdjustments,
  DEFAULT_MASK_PANELS,
  DEFAULT_DEVELOP_PARAMS,
<<<<<<< Updated upstream
=======
  NEUTRAL_TEMPERATURE_K,
  assignDevelopParam,
>>>>>>> Stashed changes
  normalizeParams,
} from "@/catalog/types";

export type ToolMode = "none" | "mask" | "retouch" | "hsl-picker";
import type { HistogramData } from "@/rendering/histogram";
import { catalogStorage } from "@/catalog/storage";
import { broadcast } from "./broadcast";
<<<<<<< Updated upstream
import { nextGuide, type CropGuide } from "@/modules/develop/crop-guides";
=======
import { createCropSlice, type CropSlice } from "./develop-slices/crop-slice";
import { createViewSlice, type ViewSlice } from "./develop-slices/view-slice";
import { createMaskSlice, type MaskSlice } from "./develop-slices/mask-slice";
import { pushEdit } from "./develop-slices/push-edit";
>>>>>>> Stashed changes
import { emitEditCommit } from "@/extensions/registry";
import { normalizeParamBag } from "@/extensions/param-registry";
import { useCatalogStore } from "./catalog-store";
import { regenerateEditedThumbnail } from "./edited-thumbnail";

interface DevelopState {
  photoId: string | null;
  params: DevelopParams;
  /** Transient render-only override: when set, the renderer draws these params
   *  instead of `params` without touching history (used for preset hover
   *  preview). Cleared on mouse-out, on apply, and when switching photos. */
  previewParams: DevelopParams | null;
  /** Render-only override for the extension param bag, paired with
   *  `previewParams` for the preset hover preview. Holds the preset's
   *  contributed params merged over the live bag, so a partial preset previews
   *  its extension adjustments (e.g. a film sim) without dropping untouched
   *  ones. Null when no preview is active; cleared whenever previewParams is. */
  previewParamBag: Record<string, unknown> | null;
  /** Dynamic parameter bag keyed by qualified names (e.g. "core.exposure.exposure").
   *  During migration, kept in sync with `params` via a bidirectional bridge.
   *  Will become the sole representation once all stages are extracted. */
  paramBag: Record<string, unknown>;
  history: EditSnapshot[];
  historyIndex: number;
  histogram: HistogramData | null;
  asShotTemperature: number;
  /** True dimensions of the decoded source last handed to the renderer (already
   *  upright). Panels derive imageAspect from this, not photo.width/height, so
   *  aspect-locked crops / Upright match the pixels on screen when a decode path
   *  transposes stored metadata. {0,0} until the first frame decodes. */
  sourceSize: { width: number; height: number };

  // Whether the guided-upright drawing overlay is open. Transient: guided can be
  // the selected upright mode without the line-drawing overlay capturing the
  // canvas, so this is separate from params.uprightMode and not persisted.
  guidedEditing: boolean;
  setGuidedEditing: (v: boolean) => void;

  // Crop tool UI state (not part of the edit, so not persisted to history).
  cropping: boolean;
  constrainCrop: boolean;
  cropAspect: number; // -1 = original (image's own aspect); 0 = free; else target width:height in pixels
  cropGuide: CropGuide; // active composition overlay
  cropGuideFlip: number; // 0-3: identity / mirror-x / mirror-y / 180°
  setCropping: (v: boolean) => void;
  setConstrainCrop: (v: boolean) => void;
  setCropAspect: (r: number) => void;
  setCropGuide: (g: CropGuide) => void;
  cycleCropGuide: () => void;
  cycleCropGuideFlip: () => void;

  // Per-panel preview-off (view-only, momentary): keyed by panel id. While a
  // panel is bypassed the renderer neutralizes its contribution (see
  // applyPanelBypass / bypassParamBag) without touching the stored edit, so the
  // user can see the image without it. Deliberately NOT persisted — it only ever
  // reflects a held button, so it must never survive a reload (and never reaches
  // thumbnails/export, which would diverge from the saved edit). The eye UI lives
  // in the optional "panel-click-to-toggle" extension; with no extension the map
  // stays empty and nothing is bypassed.
  bypassedPanels: Record<string, boolean>;
  /** Set a panel's preview-off state directly (used for press-and-hold). */
  setPanelBypass: (panelId: string, on: boolean) => void;
  togglePanelBypass: (panelId: string) => void;

  // Clipping overlay: bitmask (bit 0 = shadows, bit 1 = highlights).
  showClipping: 0 | 1 | 2 | 3;
  setShowClipping: (mode: 0 | 1 | 2 | 3) => void;
  toggleClipping: () => void;

  // Color assessment (ISO 12646 proofing): frames the image in brilliant white
  // on a fixed middle-grey surround, giving the eye a white + neutral reference
  // for judging tone and color (as darktable's Ctrl+B mode). Persisted.
  colorAssessment: boolean;
  toggleColorAssessment: () => void;

  // White-balance eyedropper: when true, the next click on the image samples a
  // neutral target and solves Temp/Tint. Ephemeral UI state, not persisted.
  wbPicking: boolean;
  setWbPicking: (v: boolean) => void;

  // HSL color picker: when true, click+drag on image adjusts HSL for sampled color.
  hslPicking: boolean;
  setHslPicking: (v: boolean) => void;

  // Mask colour-range eyedropper: when true, the next image click samples a
  // target colour into the selected colour-range component. Ephemeral.
  maskColorPicking: boolean;
  setMaskColorPicking: (v: boolean) => void;
  selectedHslBand: "hue" | "saturation" | "luminance";
  setSelectedHslBand: (band: "hue" | "saturation" | "luminance") => void;

  // Mask / retouch tool UI state (ephemeral, not persisted to history).
  activeTool: ToolMode;
  maskToolType: MaskType;
  maskCompMode: MaskComponentMode; // whether the next created component adds or subtracts
  maskAddTarget: "new" | "current"; // start a fresh mask, or extend the selected one
  selectedMaskId: string | null;
  selectedComponentId: string | null; // component being edited on-canvas
  hoveredMaskId: string | null; // mask hovered in the panel list -> coverage overlay
  maskTab: "coverage" | "adjust"; // selected-mask editor tab (gates the overlay)
  brushPreview: boolean; // true while a brush size/feather slider is being dragged
  // Sharpening preview shown while Alt/Ctrl-dragging a Detail-panel sharpening
  // slider: 0 = off, 1 = masking, 2 = detail, 3 = luminance. Transient (not
  // persisted, not broadcast) — like brushPreview.
  sharpenViz: number;
  selectedSpotId: string | null;
  brushSize: number; // image-height fraction
  brushFeather: number; // 0..1
  brushOpacity: number; // 0..1 coverage ceiling
  brushFlow: number; // 0..1 per-dab deposit
  brushErase: boolean;
  retouchSize: number; // image-height fraction
  retouchFeather: number; // 0..100
  retouchOpacity: number; // 0..100
  retouchMode: "heal" | "clone";
  setActiveTool: (t: ToolMode) => void;
  setMaskToolType: (t: MaskType) => void;
  setMaskCompMode: (m: MaskComponentMode) => void;
  setMaskAddTarget: (t: "new" | "current") => void;
  selectMask: (id: string | null) => void;
  selectComponent: (id: string | null) => void;
  setHoveredMaskId: (id: string | null) => void;
  setMaskTab: (tab: "coverage" | "adjust") => void;
  setBrushPreview: (v: boolean) => void;
  setSharpenViz: (mode: number) => void;
  selectSpot: (id: string | null) => void;
  setBrushSize: (v: number) => void;
  setBrushFeather: (v: number) => void;
  setBrushOpacity: (v: number) => void;
  setBrushFlow: (v: number) => void;
  setBrushErase: (v: boolean) => void;
  setRetouchSize: (v: number) => void;
  setRetouchFeather: (v: number) => void;
  setRetouchOpacity: (v: number) => void;
  setRetouchMode: (v: "heal" | "clone") => void;

  // Mask data mutations (persisted; commitEdit ends a gesture for undo).
  addMask: (mask: Mask) => void;
  updateMask: (id: string, patch: Partial<Mask>) => void;
  updateMaskAdj: (id: string, patch: Partial<MaskAdjustments>) => void;
  renameMask: (id: string, name: string) => void;
  // Component mutations within a mask.
  addComponent: (maskId: string, comp: MaskComponent) => void;
  updateComponent: (maskId: string, compId: string, patch: Partial<MaskComponent>) => void;
  removeComponent: (maskId: string, compId: string) => void;
  cycleComponentMode: (maskId: string, compId: string) => void;
  // Add a parametric range component (luminance / colour). Appends to the
  // selected mask (as an intersect by default) or starts a new mask.
  addRangeComponent: (kind: "lumRange" | "colorRange") => void;
  addBrushDab: (maskId: string, compId: string, dab: BrushDab) => void;
  removeMask: (id: string) => void;
  // Retouch data mutations.
  addSpot: (spot: RetouchSpot) => void;
  updateSpot: (id: string, patch: Partial<RetouchSpot>) => void;
  removeSpot: (id: string) => void;

  setHistogram: (histogram: HistogramData | null) => void;
  setSourceSize: (width: number, height: number) => void;
  loadEdit: (photoId: string, asShotTemperature?: number) => Promise<void>;
  setParam: <K extends keyof DevelopParams>(
    key: K,
    value: DevelopParams[K],
  ) => void;
  /** Set a dynamic parameter by qualified key (e.g. "core.exposure.exposure"). */
  setDynParam: (key: string, value: unknown) => void;
  /** Set multiple dynamic parameters at once. */
  setDynParams: (patch: Record<string, unknown>) => void;
  setToneCurve: (channel: ToneCurveChannel, points: CurvePoint[]) => void;
  setHslValue: (band: HSLBand, channel: HSLChannel, value: number) => void;
  /** Replace the live params wholesale (the caller merges a partial preset over
   *  the current params first) and merge the preset's contributed bag over the
   *  live one, committed as one undoable edit. Full params only — a partial
   *  would silently reset every omitted core adjustment to its default. */
  applyPreset: (
    params: DevelopParams,
    paramBag?: Record<string, unknown>,
  ) => Promise<void>;
  /** Set (or clear with null) the render-only preview params, optionally with a
   *  preset's contributed param bag (previewed by merging over the live bag). No
   *  history write, no broadcast — purely local to the Develop canvas. */
  setPreviewParams: (
    params: Partial<DevelopParams> | null,
    paramBag?: Record<string, unknown> | null,
  ) => void;
  commitEdit: (label: string) => Promise<void>;
  /** Reset just the given top-level param keys to their defaults (temperature
   *  falls back to the photo's as-shot WB), as one undoable edit. Backs the
   *  per-panel "Reset to defaults" header action. */
  resetParams: (keys: (keyof DevelopParams)[], label: string) => Promise<void>;
  undo: () => void;
  redo: () => void;
  reset: () => Promise<void>;
  canUndo: () => boolean;
  canRedo: () => boolean;
}

<<<<<<< Updated upstream
// Shared id generator for masks / components created from the panel (range
// masks have no canvas gesture, so they're built here rather than in the overlay).
let idSeq = 0;
const genId = (p: string) => `${p}-${Date.now().toString(36)}-${idSeq++}`;

// Broadcast the current params so the renderer re-renders live during a mask /
// retouch gesture. History is written separately by commitEdit at gesture end.
function pushEdit(get: () => DevelopState) {
  const s = get();
  broadcast({
    type: "edit-update",
    payload: { photoId: s.photoId, params: s.params },
  });
}
=======
// Ephemeral mask/retouch tool state carries ids from params.masks / params.retouch;
// switching photos must clear it or the new photo opens with a dangling selection
// (or an armed tool) pointing at the previous photo's objects.
const RESET_TOOL_SELECTION: Partial<DevelopState> = {
  activeTool: "none",
  selectedMaskId: null,
  selectedComponentId: null,
  selectedSpotId: null,
  hoveredMaskId: null,
};
>>>>>>> Stashed changes

// Step the history cursor (undo = -1, redo = +1), broadcast the restored
// params, and persist the new cursor — without persisting, switching photos
// (or another window) snapped the stack back to the last commit, which made
// redo/undo positions silently vanish. Restoring a snapshot is a look change
// like a commit, so it also refreshes the grid thumbnail and re-emits the
// edit to extensions (else the Library thumbnail and any XMP sidecar stay at
// the pre-undo look while the stored cursor points elsewhere).
function moveHistory(
  get: () => DevelopState,
  set: (p: Partial<DevelopState>) => void,
  dir: -1 | 1,
): void {
  const { photoId, history, historyIndex, asShotTemperature } = get();
  const newIndex = historyIndex + dir;
  if (newIndex < 0 || newIndex > history.length - 1) return;
  const snapshot = history[newIndex];
  // Normalize on the way out, not just at load: a stack read from disk carries
  // snapshots written before newer params existed, and stepping into one must
  // fill today's defaults rather than hand the renderer a half-shaped object.
  const params = normalizeParams(snapshot.params);
  const paramBag = normalizeParamBag(snapshot.paramBag);
  set({ historyIndex: newIndex, params, paramBag });
  broadcast({ type: "edit-update", payload: { photoId, params } });
  if (!photoId) return;

  const editState: EditState = {
    photoId,
    stack: history,
    currentIndex: newIndex,
  };
  void catalogStorage().putEditState(editState);

  const photo = useCatalogStore.getState().photos.find((p) => p.id === photoId);
  if (photo) void emitEditCommit({ photo, editState });

  regenerateEditedThumbnail(photoId, params, asShotTemperature, paramBag);
}

export const useDevelopStore = create<DevelopState>((set, get) => ({
  photoId: null,
  params: normalizeParams(undefined),
  previewParams: null,
  previewParamBag: null,
  paramBag: {},
  history: [],
  historyIndex: -1,
  histogram: null,
  asShotTemperature: NEUTRAL_TEMPERATURE_K,
  sourceSize: { width: 0, height: 0 },

  guidedEditing: false,
  setGuidedEditing: (guidedEditing) => set({ guidedEditing }),

  cropping: false,
  constrainCrop: true,
  cropAspect: -1,
  cropGuide: "thirds",
  cropGuideFlip: 0,
  setCropping: (cropping) => set({ cropping }),
  setConstrainCrop: (constrainCrop) => set({ constrainCrop }),
  setCropAspect: (cropAspect) => set({ cropAspect }),
  setCropGuide: (cropGuide) => set({ cropGuide }),
  cycleCropGuide: () => set((s) => ({ cropGuide: nextGuide(s.cropGuide) })),
  cycleCropGuideFlip: () =>
    set((s) => ({ cropGuideFlip: (s.cropGuideFlip + 1) % 4 })),

  bypassedPanels: {},
  setPanelBypass: (panelId, on) => {
    set((s) => {
      if (!!s.bypassedPanels[panelId] === on) return s; // no-op, no re-render
      const next = { ...s.bypassedPanels };
      if (on) next[panelId] = true;
      else delete next[panelId];
      return { bypassedPanels: next };
    });
  },
  togglePanelBypass: (panelId) => {
    set((s) => {
      const next = { ...s.bypassedPanels };
      if (next[panelId]) delete next[panelId];
      else next[panelId] = true;
      return { bypassedPanels: next };
    });
  },

  showClipping: (() => {
    try { const v = localStorage.getItem("sl_show_clipping"); return v === "1" ? 1 : v === "2" ? 2 : v === "3" ? 3 : 0; } catch { return 0; }
  })() as 0 | 1 | 2 | 3,
  setShowClipping: (mode) => {
    set({ showClipping: mode });
    try { localStorage.setItem("sl_show_clipping", String(mode)); } catch {}
  },
  toggleClipping: () => {
    const next = (get().showClipping === 0 ? 3 : 0) as 0 | 3;
    set({ showClipping: next });
    try { localStorage.setItem("sl_show_clipping", String(next)); } catch {}
  },

  colorAssessment: (() => {
    try { return localStorage.getItem("sl_color_assessment") === "1"; } catch { return false; }
  })(),
  toggleColorAssessment: () => {
    const next = !get().colorAssessment;
    set({ colorAssessment: next });
    try { localStorage.setItem("sl_color_assessment", next ? "1" : "0"); } catch {}
  },

  wbPicking: false,
  setWbPicking: (wbPicking) => set({ wbPicking }),

  hslPicking: false,
  setHslPicking: (hslPicking) => set({ hslPicking }),
  maskColorPicking: false,
  setMaskColorPicking: (maskColorPicking) => set({ maskColorPicking }),
  selectedHslBand: "hue",
  setSelectedHslBand: (selectedHslBand) => set({ selectedHslBand }),

  activeTool: "none",
  maskToolType: "radial",
  maskCompMode: "add",
  maskAddTarget: "new",
  selectedMaskId: null,
  selectedComponentId: null,
  hoveredMaskId: null,
  maskTab: "coverage",
  brushPreview: false,
  sharpenViz: 0,
  selectedSpotId: null,
  brushSize: 0.08,
  brushFeather: 0.5,
  brushOpacity: 1,
  brushFlow: 1,
  brushErase: false,
  retouchSize: 0.04,
  retouchFeather: 50,
  retouchOpacity: 100,
  retouchMode: "heal" as const,
  setActiveTool: (activeTool) => set({ activeTool }),
  setMaskToolType: (maskToolType) => set({ maskToolType }),
  setMaskCompMode: (maskCompMode) => set({ maskCompMode }),
  setMaskAddTarget: (maskAddTarget) => set({ maskAddTarget }),
  selectMask: (selectedMaskId) => set({ selectedMaskId }),
  selectComponent: (selectedComponentId) => set({ selectedComponentId }),
  setHoveredMaskId: (hoveredMaskId) => set({ hoveredMaskId }),
  setMaskTab: (maskTab) => set({ maskTab }),
  setBrushPreview: (brushPreview) => set({ brushPreview }),
  setSharpenViz: (sharpenViz) => set({ sharpenViz }),
  selectSpot: (selectedSpotId) => set({ selectedSpotId }),
  setBrushSize: (brushSize) => set({ brushSize }),
  setBrushFeather: (brushFeather) => set({ brushFeather }),
  setBrushOpacity: (brushOpacity) => set({ brushOpacity }),
  setBrushFlow: (brushFlow) => set({ brushFlow }),
  setBrushErase: (brushErase) => set({ brushErase }),
  setRetouchSize: (retouchSize) => set({ retouchSize }),
  setRetouchFeather: (retouchFeather) => set({ retouchFeather }),
  setRetouchOpacity: (retouchOpacity) => set({ retouchOpacity }),
  setRetouchMode: (retouchMode) => set({ retouchMode }),

  addMask(mask) {
    set((s) => {
      if (s.params.masks.length >= MAX_MASKS) return s;
      return {
        params: { ...s.params, masks: [...s.params.masks, mask] },
        selectedMaskId: mask.id,
        selectedComponentId: mask.components[mask.components.length - 1]?.id ?? null,
      };
    });
    pushEdit(get);
  },

  addComponent(maskId, comp) {
    set((s) => ({
      params: {
        ...s.params,
        masks: s.params.masks.map((m) =>
          m.id === maskId ? { ...m, components: [...m.components, comp] } : m,
        ),
      },
      selectedMaskId: maskId,
      selectedComponentId: comp.id,
    }));
    pushEdit(get);
  },

  // Cycle a component's combine mode: add -> subtract -> intersect -> add.
  cycleComponentMode(maskId, compId) {
    set((s) => ({
      params: {
        ...s.params,
        masks: s.params.masks.map((m) =>
          m.id === maskId
            ? {
                ...m,
                components: m.components.map((c) => {
                  if (c.id !== compId) return c;
                  const next: MaskComponentMode =
                    c.mode === "add" ? "subtract" : c.mode === "subtract" ? "intersect" : "add";
                  return { ...c, mode: next };
                }),
              }
            : m,
        ),
      },
    }));
    pushEdit(get);
  },

  addRangeComponent(kind) {
    const geo =
      kind === "lumRange"
        ? { lumRange: defaultLumRange() }
        : { colorRange: defaultColorRange() };
    const s = get();
    const sel = s.params.masks.find((m) => m.id === s.selectedMaskId) ?? null;
    if (sel) {
      // Range masks are usually used to confine an existing region -> intersect.
      const comp: MaskComponent = {
        id: genId("comp"),
        kind,
        mode: sel.components.length > 0 ? "intersect" : "add",
        invert: false,
        ...geo,
      };
      get().addComponent(sel.id, comp);
      return;
    }
    // No mask selected: start a new mask anchored on the range component.
    const id = genId("mask");
    const mask: Mask = {
      id,
      name: kind === "lumRange" ? "Luminance" : "Color",
      visible: true,
      invert: false,
      opacity: 100,
      adj: defaultMaskAdjustments(),
      panels: [...DEFAULT_MASK_PANELS],
      components: [
        { id: genId("comp"), kind, mode: "add", invert: false, ...geo },
      ],
    };
    get().addMask(mask);
  },

  updateComponent(maskId, compId, patch) {
    set((s) => ({
      params: {
        ...s.params,
        masks: s.params.masks.map((m) =>
          m.id === maskId
            ? {
                ...m,
                components: m.components.map((c) =>
                  c.id === compId ? { ...c, ...patch } : c,
                ),
              }
            : m,
        ),
      },
    }));
    pushEdit(get);
  },

  // Removing the last component removes the whole mask.
  removeComponent(maskId, compId) {
    set((s) => {
      const masks: Mask[] = [];
      for (const m of s.params.masks) {
        if (m.id !== maskId) {
          masks.push(m);
          continue;
        }
        const components = m.components.filter((c) => c.id !== compId);
        if (components.length > 0) masks.push({ ...m, components });
        // else: drop the mask entirely
      }
      const maskGone = !masks.some((m) => m.id === maskId);
      return {
        params: { ...s.params, masks },
        selectedMaskId: maskGone ? null : s.selectedMaskId,
        selectedComponentId:
          s.selectedComponentId === compId ? null : s.selectedComponentId,
      };
    });
    pushEdit(get);
  },

  updateMask(id, patch) {
    set((s) => ({
      params: {
        ...s.params,
        masks: s.params.masks.map((m) => (m.id === id ? { ...m, ...patch } : m)),
      },
    }));
    pushEdit(get);
  },

  updateMaskAdj(id, patch) {
    set((s) => ({
      params: {
        ...s.params,
        masks: s.params.masks.map((m) =>
          m.id === id ? { ...m, adj: { ...m.adj, ...patch } } : m,
        ),
      },
    }));
    pushEdit(get);
  },

  renameMask(id, name) {
    set((s) => ({
      params: {
        ...s.params,
        masks: s.params.masks.map((m) => (m.id === id ? { ...m, name } : m)),
      },
    }));
    pushEdit(get);
  },

  addBrushDab(maskId, compId, dab) {
    set((s) => ({
      params: {
        ...s.params,
        masks: s.params.masks.map((m) =>
          m.id === maskId
            ? {
                ...m,
                components: m.components.map((c) =>
                  c.id === compId && c.brush
                    ? { ...c, brush: { ...c.brush, dabs: [...c.brush.dabs, dab] } }
                    : c,
                ),
              }
            : m,
        ),
      },
    }));
    pushEdit(get);
  },

  removeMask(id) {
    set((s) => ({
      params: { ...s.params, masks: s.params.masks.filter((m) => m.id !== id) },
      selectedMaskId: s.selectedMaskId === id ? null : s.selectedMaskId,
      selectedComponentId:
        s.selectedMaskId === id ? null : s.selectedComponentId,
    }));
    pushEdit(get);
  },

  addSpot(spot) {
    set((s) => {
      if (s.params.retouch.length >= MAX_RETOUCH) return s;
      return {
        params: { ...s.params, retouch: [...s.params.retouch, spot] },
        selectedSpotId: spot.id,
      };
    });
    pushEdit(get);
  },

  updateSpot(id, patch) {
    set((s) => ({
      params: {
        ...s.params,
        retouch: s.params.retouch.map((sp) =>
          sp.id === id ? { ...sp, ...patch } : sp,
        ),
      },
    }));
    pushEdit(get);
  },

  removeSpot(id) {
    set((s) => ({
      params: { ...s.params, retouch: s.params.retouch.filter((sp) => sp.id !== id) },
      selectedSpotId: s.selectedSpotId === id ? null : s.selectedSpotId,
    }));
    pushEdit(get);
  },

  setHistogram: (histogram) => set({ histogram }),

  setSourceSize: (width, height) =>
    set((s) =>
      s.sourceSize.width === width && s.sourceSize.height === height
        ? s
        : { sourceSize: { width, height } },
    ),

  async loadEdit(photoId: string, asShotTemperature?: number) {
    const asShot = asShotTemperature ?? NEUTRAL_TEMPERATURE_K;
    const editState = await catalogStorage().getEditState(photoId);
    if (editState && editState.stack.length > 0) {
      // Older stacks lack the seeded "Original" snapshot — prepend one so the
      // first real edit is always undoable.
      let stack = editState.stack;
      // The stored cursor can fall outside its stack (a truncated write, a
      // catalog edited by hand); clamp so the photo opens on its nearest real
      // snapshot instead of throwing on an undefined one.
      let index = Math.min(Math.max(editState.currentIndex, 0), stack.length - 1);
      if (stack[0].label !== "Original") {
        stack = [
          {
            timestamp: stack[0].timestamp,
            label: "Original",
            params: normalizeParams({ temperature: asShot }),
            paramBag: {},
          },
          ...stack,
        ];
        index += 1;
      }
      set({
        photoId,
        asShotTemperature: asShot,
        params: normalizeParams(stack[index].params),
        paramBag: normalizeParamBag(stack[index].paramBag),
        previewParams: null,
        previewParamBag: null,
        history: stack,
        historyIndex: index,
        guidedEditing: false,
        ...RESET_TOOL_SELECTION,
      });
    } else {
      // Seed history with the untouched state so undo can return to it.
      // Use the camera's as-shot WB as the default temperature.
      const initial = normalizeParams({ temperature: asShot });
      set({
        photoId,
        asShotTemperature: asShot,
        params: initial,
        paramBag: {},
        previewParams: null,
        previewParamBag: null,
        history: [
          {
            timestamp: Date.now(),
            label: "Original",
            params: initial,
            paramBag: {},
          },
        ],
        historyIndex: 0,
        guidedEditing: false,
        ...RESET_TOOL_SELECTION,
      });
    }
  },

  setParam(key, value) {
    set((s) => ({
      params: { ...s.params, [key]: value },
    }));
    pushEdit(get);
  },

  setDynParam(key, value) {
    set((s) => ({
      paramBag: { ...s.paramBag, [key]: value },
    }));
    pushEdit(get);
  },

  setDynParams(patch) {
    set((s) => ({
      paramBag: { ...s.paramBag, ...patch },
    }));
    pushEdit(get);
  },

  setToneCurve(channel, points) {
    set((s) => ({
      params: {
        ...s.params,
        toneCurve: { ...s.params.toneCurve, [channel]: points },
      },
    }));
    pushEdit(get);
  },

  setHslValue(band, channel, value) {
    set((s) => ({
      params: {
        ...s.params,
        hsl: {
          ...s.params.hsl,
          [band]: { ...s.params.hsl[band], [channel]: value },
        },
      },
    }));
    pushEdit(get);
  },

  async applyPreset(params, paramBag) {
    set((s) => ({
      previewParams: null,
      previewParamBag: null,
      params: normalizeParams(params),
      // Merge the preset's contributed params over the current bag (a partial
      // preset leaves untouched extension settings in place).
      paramBag: paramBag
        ? { ...s.paramBag, ...normalizeParamBag(paramBag) }
        : s.paramBag,
    }));
    pushEdit(get);
    await get().commitEdit("Preset");
  },

  setPreviewParams(params, paramBag) {
    set((s) => ({
      previewParams: params ? normalizeParams(params) : null,
      // Pair the bag with the param preview: merge the preset's contributed
      // params over the live bag (so untouched extension settings stay), and
      // clear it whenever the param preview clears.
      previewParamBag:
        params && paramBag
          ? { ...s.paramBag, ...normalizeParamBag(paramBag) }
          : null,
    }));
  },

  async commitEdit(label: string) {
    const { photoId, params, paramBag, history, historyIndex, asShotTemperature } = get();
    if (!photoId) return;

    const snapshot: EditSnapshot = {
      timestamp: Date.now(),
      label,
      params: { ...params },
      paramBag: { ...paramBag },
    };

    const trimmed = history.slice(0, historyIndex + 1);
    const newHistory = [...trimmed, snapshot];
    const newIndex = newHistory.length - 1;

    set({ history: newHistory, historyIndex: newIndex });

    const editState: EditState = {
      photoId,
      stack: newHistory,
      currentIndex: newIndex,
    };
    await catalogStorage().putEditState(editState);

    // Let extensions persist the committed edit elsewhere.
    const photo = useCatalogStore.getState().photos.find((p) => p.id === photoId);
    if (photo) await emitEditCommit({ photo, editState });

    // Re-render this one photo's grid thumbnail from its committed look (cheap,
    // in-memory, single photo — not the removed folder-wide pump). Fire and
    // forget so the commit stays snappy.
    regenerateEditedThumbnail(photoId, params, asShotTemperature, paramBag);

    // Announce the committed state so the Library refreshes this photo's
    // histogram the moment it's edited — for any visible photo, in any window —
    // instead of waiting on the periodic catalog poll.
    broadcast({ type: "edit-update", payload: { photoId, params } });
  },

  undo() {
    moveHistory(get, set, -1);
  },

  redo() {
    moveHistory(get, set, +1);
  },

  async resetParams(keys, label) {
    const { asShotTemperature } = get();
    if (keys.length === 0) return;
    set((s) => {
      const next = { ...s.params } as unknown as Record<string, unknown>;
      const defaults = DEFAULT_DEVELOP_PARAMS as unknown as Record<string, unknown>;
      for (const k of keys) {
        next[k] = k === "temperature" ? asShotTemperature : structuredClone(defaults[k]);
      }
      return { params: next as unknown as DevelopParams };
    });
    pushEdit(get);
    await get().commitEdit(label);
  },

  async reset() {
    const fresh = normalizeParams({ temperature: get().asShotTemperature });
    set({ params: fresh, paramBag: {} });
    pushEdit(get);
    // Persist as an undoable history step so the reset survives navigation.
    await get().commitEdit("Reset");
  },

  canUndo: () => get().historyIndex > 0,
  canRedo: () => get().historyIndex < get().history.length - 1,
}));
