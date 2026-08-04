// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Canvas-view and picker UI, carved out of the develop store as a self-contained
// slice: overlay toggles (clipping, colour-assessment), the guided-upright
// overlay flag, per-panel preview-off, and the click-to-sample picker modes
// (white balance, HSL, mask colour-range). None of this is part of the edit;
// only the two view toggles persist (to localStorage), the rest is ephemeral.
// Composed into the store in develop-store.ts; `DevelopState extends ViewSlice`.

import type { StateCreator } from "zustand";
import type { DevelopState } from "../develop-store";

export interface ViewSlice {
  // Whether the guided-upright drawing overlay is open. Transient: guided can be
  // the selected upright mode without the line-drawing overlay capturing the
  // canvas, so this is separate from params.uprightMode and not persisted.
  guidedEditing: boolean;
  setGuidedEditing: (v: boolean) => void;

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
}

export const createViewSlice: StateCreator<DevelopState, [], [], ViewSlice> = (
  set,
  get,
) => ({
  guidedEditing: false,
  setGuidedEditing: (guidedEditing) => set({ guidedEditing }),

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
});
