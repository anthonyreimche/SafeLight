// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

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
import {
  DEFAULT_DEVELOP_PARAMS,
  assignDevelopParam,
  normalizeParams,
} from "@/catalog/types";

export type { ToolMode } from "./develop-slices/mask-slice";
import type { HistogramData } from "@/rendering/histogram";
import { catalogStorage } from "@/catalog/storage";
import { broadcast } from "./broadcast";
import { createCropSlice, type CropSlice } from "./develop-slices/crop-slice";
import { createViewSlice, type ViewSlice } from "./develop-slices/view-slice";
import { createMaskSlice, type MaskSlice } from "./develop-slices/mask-slice";
import { emitEditCommit } from "@/extensions/registry";
import { normalizeParamBag } from "@/extensions/param-registry";
import { useCatalogStore } from "./catalog-store";
import { regenerateEditedThumbnail } from "./edited-thumbnail";

export interface DevelopState extends CropSlice, ViewSlice, MaskSlice {
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

  // Crop tool UI lives in CropSlice (develop-slices/crop-slice.ts); canvas-view
  // overlays and picker modes live in ViewSlice (develop-slices/view-slice.ts).

  // Mask / retouch tool UI + data mutations live in MaskSlice
  // (develop-slices/mask-slice.ts).

  setHistogram: (histogram: HistogramData | null) => void;
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
  applyPreset: (
    params: Partial<DevelopParams>,
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

// Step the history cursor (undo = -1, redo = +1), broadcast the restored
// params, and persist the new cursor — without persisting, switching photos
// (or another window) snapped the stack back to the last commit, which made
// redo/undo positions silently vanish.
function moveHistory(
  get: () => DevelopState,
  set: (p: Partial<DevelopState>) => void,
  dir: -1 | 1,
): void {
  const { photoId, history, historyIndex } = get();
  const newIndex = historyIndex + dir;
  if (newIndex < 0 || newIndex > history.length - 1) return;
  set({
    historyIndex: newIndex,
    params: { ...history[newIndex].params },
    paramBag: { ...(history[newIndex].paramBag ?? {}) },
  });
  broadcast({
    type: "edit-update",
    payload: { photoId, params: history[newIndex].params },
  });
  if (photoId) {
    void catalogStorage().putEditState({
      photoId,
      stack: history,
      currentIndex: newIndex,
    });
  }
}

export const useDevelopStore = create<DevelopState>()((set, get, store) => ({
  photoId: null,
  params: normalizeParams(undefined),
  previewParams: null,
  previewParamBag: null,
  paramBag: {},
  history: [],
  historyIndex: -1,
  histogram: null,
  asShotTemperature: 6500,

  ...createCropSlice(set, get, store),
  ...createViewSlice(set, get, store),

  ...createMaskSlice(set, get, store),

  setHistogram: (histogram) => set({ histogram }),

  async loadEdit(photoId: string, asShotTemperature?: number) {
    const asShot = asShotTemperature ?? 6500;
    const editState = await catalogStorage().getEditState(photoId);
    if (editState && editState.stack.length > 0) {
      // Older stacks lack the seeded "Original" snapshot — prepend one so the
      // first real edit is always undoable.
      let stack = editState.stack;
      let index = editState.currentIndex;
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

  setDynParam(key, value) {
    set((s) => ({
      paramBag: { ...s.paramBag, [key]: value },
    }));
    broadcast({
      type: "edit-update",
      payload: { photoId: get().photoId, params: get().params },
    });
  },

  setDynParams(patch) {
    set((s) => ({
      paramBag: { ...s.paramBag, ...patch },
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
    broadcast({
      type: "edit-update",
      payload: { photoId: get().photoId, params: get().params },
    });
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
    const { photoId, asShotTemperature } = get();
    if (keys.length === 0) return;
    set((s) => {
      const next = { ...s.params };
      for (const k of keys) {
        assignDevelopParam(
          next,
          k,
          k === "temperature" ? asShotTemperature : structuredClone(DEFAULT_DEVELOP_PARAMS[k]),
        );
      }
      return { params: next };
    });
    broadcast({
      type: "edit-update",
      payload: { photoId, params: get().params },
    });
    await get().commitEdit(label);
  },

  async reset() {
    const fresh = normalizeParams({ temperature: get().asShotTemperature });
    set({ params: fresh, paramBag: {} });
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
