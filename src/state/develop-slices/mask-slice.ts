// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Mask and retouch state, carved out of the develop store as a self-contained
// slice: the ephemeral tool UI (active tool, brush/retouch settings, selection)
// plus the data mutations on params.masks / params.retouch. The mutations write
// params directly and broadcast a live re-render (pushEdit); they do NOT commit
// to history — commitEdit ends a gesture for undo and is called by the canvas
// overlay at gesture end. Composed in develop-store.ts; `DevelopState extends
// MaskSlice`, so the slice owns these members' types.

import type { StateCreator } from "zustand";
import type {
  BrushDab,
  Mask,
  MaskAdjustments,
  MaskComponent,
  MaskComponentMode,
  MaskType,
  RetouchSpot,
} from "@/catalog/types";
import {
  MAX_MASKS,
  MAX_RETOUCH,
  defaultColorRange,
  defaultHSL,
  defaultLumRange,
  defaultMaskAdjustments,
  defaultToneCurves,
  DEFAULT_MASK_PANELS,
} from "@/catalog/types";
import { getParamDescriptor } from "@/extensions/param-registry";
import { broadcast } from "../broadcast";
import type { DevelopState } from "../develop-store";

export type ToolMode = "none" | "mask" | "retouch" | "hsl-picker";

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

// Classifier for MaskPanelContribution.owns entries. Qualified extension keys
// always contain a dot ("stage.key"), so they can't collide with these.
const MASK_ADJ_KEYS = new Set(Object.keys(defaultMaskAdjustments()));

// Route each owned value to where it lives on the mask: adjustment fields are
// zeroed either way (0 is their default), the structured blocks are seeded
// with fresh defaults or stripped, and extension keys are restored to their
// registered defaults or deleted from the bag. An unregistered extension key
// has no known default, so seeding it is a delete too — nothing is invented.
function applyOwnedValues(
  s: DevelopState,
  maskId: string,
  owns: readonly string[],
  mode: "seed" | "clear",
): void {
  const adj: Partial<MaskAdjustments> = {};
  const blocks: Partial<Mask> = {};
  const bag: Record<string, unknown> = {};
  const seed = mode === "seed";
  for (const key of owns) {
    if (MASK_ADJ_KEYS.has(key)) (adj as Record<string, number>)[key] = 0;
    else if (key === "hsl") blocks.hsl = seed ? defaultHSL() : undefined;
    else if (key === "toneCurve") blocks.toneCurve = seed ? defaultToneCurves() : undefined;
    else bag[key] = seed ? getParamDescriptor(key)?.default : undefined;
  }
  if (Object.keys(adj).length > 0) s.updateMaskAdj(maskId, adj);
  if (Object.keys(blocks).length > 0) s.updateMask(maskId, blocks);
  if (Object.keys(bag).length > 0) s.updateMaskBag(maskId, bag);
}

export interface MaskSlice {
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
  // Merge into the mask's extension-param bag; undefined values delete keys.
  updateMaskBag: (id: string, patch: Record<string, unknown>) => void;
  // Apply a mask sub-panel's `owns` list (PanelContribution.mask.owns): seed
  // writes each owned value's default (sub-panel added, or mask reset); clear
  // zeroes the adjustments and strips blocks / bag keys (sub-panel removed).
  seedMaskPanelValues: (maskId: string, owns: readonly string[]) => void;
  clearMaskPanelValues: (maskId: string, owns: readonly string[]) => void;
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
}

export const createMaskSlice: StateCreator<DevelopState, [], [], MaskSlice> = (
  set,
  get,
) => ({
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

  updateMaskBag(id, patch) {
    set((s) => ({
      params: {
        ...s.params,
        masks: s.params.masks.map((m) => {
          if (m.id !== id) return m;
          const bag: Record<string, unknown> = { ...m.bag };
          for (const [key, value] of Object.entries(patch)) {
            if (value === undefined) delete bag[key];
            else bag[key] = value;
          }
          // Drop the property when it empties, keeping persisted masks minimal.
          return { ...m, bag: Object.keys(bag).length > 0 ? bag : undefined };
        }),
      },
    }));
    pushEdit(get);
  },

  seedMaskPanelValues(maskId, owns) {
    applyOwnedValues(get(), maskId, owns, "seed");
  },

  clearMaskPanelValues(maskId, owns) {
    applyOwnedValues(get(), maskId, owns, "clear");
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
});
