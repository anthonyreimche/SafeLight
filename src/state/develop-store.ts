import { create } from "zustand";
import type {
  CurvePoint,
  DevelopParams,
  EditSnapshot,
  EditState,
  HSLBand,
  HSLChannel,
  ToneCurveChannel,
} from "@/catalog/types";
import { normalizeParams } from "@/catalog/types";
import type { HistogramData } from "@/rendering/histogram";
import { catalogDB } from "@/catalog/db";
import { broadcast } from "./broadcast";

interface DevelopState {
  photoId: string | null;
  params: DevelopParams;
  history: EditSnapshot[];
  historyIndex: number;
  histogram: HistogramData | null;

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

export const useDevelopStore = create<DevelopState>((set, get) => ({
  photoId: null,
  params: normalizeParams(undefined),
  history: [],
  historyIndex: -1,
  histogram: null,

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
