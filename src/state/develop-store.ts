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
  MaskType,
  RetouchSpot,
  ToneCurveChannel,
} from "@/catalog/types";
import { MAX_MASKS, MAX_RETOUCH, normalizeParams } from "@/catalog/types";

export type ToolMode = "none" | "mask" | "retouch";
import type { HistogramData } from "@/rendering/histogram";
import { catalogDB } from "@/catalog/db";
import { broadcast } from "./broadcast";
import { nextGuide, type CropGuide } from "@/modules/develop/crop-guides";

interface DevelopState {
  photoId: string | null;
  params: DevelopParams;
  history: EditSnapshot[];
  historyIndex: number;
  histogram: HistogramData | null;

  // Crop tool UI state (not part of the edit, so not persisted to history).
  cropping: boolean;
  constrainCrop: boolean;
  cropAspect: number; // 0 = free; else target width:height in pixels
  cropGuide: CropGuide; // active composition overlay
  setCropping: (v: boolean) => void;
  setConstrainCrop: (v: boolean) => void;
  setCropAspect: (r: number) => void;
  setCropGuide: (g: CropGuide) => void;
  cycleCropGuide: () => void;

  // Mask / retouch tool UI state (ephemeral, not persisted to history).
  activeTool: ToolMode;
  maskToolType: MaskType;
  selectedMaskId: string | null;
  selectedSpotId: string | null;
  brushSize: number; // image-height fraction
  brushFeather: number; // 0..1
  brushErase: boolean;
  retouchMode: "heal" | "clone";
  retouchSize: number; // image-height fraction
  retouchFeather: number; // 0..100
  retouchOpacity: number; // 0..100
  setActiveTool: (t: ToolMode) => void;
  setMaskToolType: (t: MaskType) => void;
  selectMask: (id: string | null) => void;
  selectSpot: (id: string | null) => void;
  setBrushSize: (v: number) => void;
  setBrushFeather: (v: number) => void;
  setBrushErase: (v: boolean) => void;
  setRetouchMode: (m: "heal" | "clone") => void;
  setRetouchSize: (v: number) => void;
  setRetouchFeather: (v: number) => void;
  setRetouchOpacity: (v: number) => void;

  // Mask data mutations (persisted; commitEdit ends a gesture for undo).
  addMask: (mask: Mask) => void;
  updateMask: (id: string, patch: Partial<Mask>) => void;
  updateMaskAdj: (id: string, patch: Partial<MaskAdjustments>) => void;
  addBrushDab: (id: string, dab: BrushDab) => void;
  removeMask: (id: string) => void;
  // Retouch data mutations.
  addSpot: (spot: RetouchSpot) => void;
  updateSpot: (id: string, patch: Partial<RetouchSpot>) => void;
  removeSpot: (id: string) => void;

  setHistogram: (histogram: HistogramData | null) => void;
  loadEdit: (photoId: string) => Promise<void>;
  setParam: <K extends keyof DevelopParams>(
    key: K,
    value: DevelopParams[K],
  ) => void;
  setToneCurve: (channel: ToneCurveChannel, points: CurvePoint[]) => void;
  setHslValue: (band: HSLBand, channel: HSLChannel, value: number) => void;
  applyPreset: (params: Partial<DevelopParams>) => Promise<void>;
  commitEdit: (label: string) => Promise<void>;
  undo: () => void;
  redo: () => void;
  reset: () => Promise<void>;
  canUndo: () => boolean;
  canRedo: () => boolean;
}

// Broadcast the current params so the renderer re-renders live during a mask /
// retouch gesture. History is written separately by commitEdit at gesture end.
function pushEdit(get: () => DevelopState) {
  const s = get();
  broadcast({
    type: "edit-update",
    payload: { photoId: s.photoId, params: s.params },
  });
}

export const useDevelopStore = create<DevelopState>((set, get) => ({
  photoId: null,
  params: normalizeParams(undefined),
  history: [],
  historyIndex: -1,
  histogram: null,

  cropping: false,
  constrainCrop: true,
  cropAspect: 0,
  cropGuide: "thirds",
  setCropping: (cropping) => set({ cropping }),
  setConstrainCrop: (constrainCrop) => set({ constrainCrop }),
  setCropAspect: (cropAspect) => set({ cropAspect }),
  setCropGuide: (cropGuide) => set({ cropGuide }),
  cycleCropGuide: () => set((s) => ({ cropGuide: nextGuide(s.cropGuide) })),

  activeTool: "none",
  maskToolType: "radial",
  selectedMaskId: null,
  selectedSpotId: null,
  brushSize: 0.08,
  brushFeather: 0.5,
  brushErase: false,
  retouchMode: "heal",
  retouchSize: 0.04,
  retouchFeather: 50,
  retouchOpacity: 100,
  setActiveTool: (activeTool) => set({ activeTool }),
  setMaskToolType: (maskToolType) => set({ maskToolType }),
  selectMask: (selectedMaskId) => set({ selectedMaskId }),
  selectSpot: (selectedSpotId) => set({ selectedSpotId }),
  setBrushSize: (brushSize) => set({ brushSize }),
  setBrushFeather: (brushFeather) => set({ brushFeather }),
  setBrushErase: (brushErase) => set({ brushErase }),
  setRetouchMode: (retouchMode) => set({ retouchMode }),
  setRetouchSize: (retouchSize) => set({ retouchSize }),
  setRetouchFeather: (retouchFeather) => set({ retouchFeather }),
  setRetouchOpacity: (retouchOpacity) => set({ retouchOpacity }),

  addMask(mask) {
    set((s) => {
      if (s.params.masks.length >= MAX_MASKS) return s;
      return {
        params: { ...s.params, masks: [...s.params.masks, mask] },
        selectedMaskId: mask.id,
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

  addBrushDab(id, dab) {
    set((s) => ({
      params: {
        ...s.params,
        masks: s.params.masks.map((m) =>
          m.id === id && m.brush
            ? { ...m, brush: { ...m.brush, dabs: [...m.brush.dabs, dab] } }
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

  async loadEdit(photoId: string) {
    const editState = await catalogDB.getEditState(photoId);
    if (editState && editState.stack.length > 0) {
      set({
        photoId,
        params: normalizeParams(editState.stack[editState.currentIndex].params),
        history: editState.stack,
        historyIndex: editState.currentIndex,
      });
    } else {
      set({
        photoId,
        params: normalizeParams(undefined),
        history: [],
        historyIndex: -1,
      });
    }
  },

  setParam(key, value) {
    set((s) => ({
      params: { ...s.params, [key]: value },
    }));
    broadcast({
      type: "edit-update",
      payload: { photoId: get().photoId, params: get().params },
    });
  },

  setToneCurve(channel, points) {
    set((s) => ({
      params: {
        ...s.params,
        toneCurve: { ...s.params.toneCurve, [channel]: points },
      },
    }));
    broadcast({
      type: "edit-update",
      payload: { photoId: get().photoId, params: get().params },
    });
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
    broadcast({
      type: "edit-update",
      payload: { photoId: get().photoId, params: get().params },
    });
  },

  async applyPreset(params) {
    set({ params: normalizeParams(params) });
    broadcast({
      type: "edit-update",
      payload: { photoId: get().photoId, params: get().params },
    });
    await get().commitEdit("Preset");
  },

  async commitEdit(label: string) {
    const { photoId, params, history, historyIndex } = get();
    if (!photoId) return;

    const snapshot: EditSnapshot = {
      timestamp: Date.now(),
      label,
      params: { ...params },
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
    await catalogDB.putEditState(editState);
  },

  undo() {
    const { history, historyIndex } = get();
    if (historyIndex <= 0) return;
    const newIndex = historyIndex - 1;
    set({
      historyIndex: newIndex,
      params: { ...history[newIndex].params },
    });
    broadcast({
      type: "edit-update",
      payload: { photoId: get().photoId, params: history[newIndex].params },
    });
  },

  redo() {
    const { history, historyIndex } = get();
    if (historyIndex >= history.length - 1) return;
    const newIndex = historyIndex + 1;
    set({
      historyIndex: newIndex,
      params: { ...history[newIndex].params },
    });
    broadcast({
      type: "edit-update",
      payload: { photoId: get().photoId, params: history[newIndex].params },
    });
  },

  async reset() {
    const fresh = normalizeParams(undefined);
    set({ params: fresh });
    broadcast({
      type: "edit-update",
      payload: { photoId: get().photoId, params: fresh },
    });
    // Persist as an undoable history step so the reset survives navigation.
    await get().commitEdit("Reset");
  },

  canUndo: () => get().historyIndex > 0,
  canRedo: () => get().historyIndex < get().history.length - 1,
}));
