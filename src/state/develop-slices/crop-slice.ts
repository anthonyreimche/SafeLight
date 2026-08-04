// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Crop tool UI state, carved out of the develop store as a self-contained slice.
// This is view state for the crop tool, NOT part of the edit — it is never
// written to history or persisted. Composed into the store in develop-store.ts;
// `DevelopState extends CropSlice`, so the slice owns these members' types.

import type { StateCreator } from "zustand";
import { nextGuide, type CropGuide } from "@/modules/develop/crop-guides";
import type { DevelopState } from "../develop-store";

export interface CropSlice {
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
}

// The slice receives the full-store `set`/`get` (typed against DevelopState), so
// it can read and write the whole store if it ever needs to — but crop state is
// independent, so these setters only touch their own keys.
export const createCropSlice: StateCreator<DevelopState, [], [], CropSlice> = (
  set,
) => ({
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
});
