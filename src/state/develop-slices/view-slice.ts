// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Canvas-view and picker UI, carved out of the develop store as a self-contained
// slice: overlay toggles (clipping, colour-assessment, soft proof), the guided-upright
// overlay flag, per-panel preview-off, and the click-to-sample picker modes
// (white balance, HSL, mask colour-range). None of this is part of the edit;
// only clipping and colour-assessment persist (to localStorage), the rest is ephemeral.
// Composed into the store in develop-store.ts; `DevelopState extends ViewSlice`.

import type { StateCreator } from "zustand";

/** Clipping overlay bits: 1 shadows, 2 highlights, 4 the gamut warning, which
 *  only version 3 photos show. */
export type ClippingMask = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface ViewSlice {
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

  // Clipping overlay. J toggles every warning; the histogram's triangles flip
  // shadows and highlights one at a time.
  showClipping: ClippingMask;
  setShowClipping: (mode: ClippingMask) => void;
  toggleClipping: () => void;

  // Soft proof: previews the export colour space on photos that have one (version
  // 3). Global across photos, off on launch, so never persisted.
  proof: boolean;
  toggleProof: () => void;

  // Colour assessment (ISO 12646 proofing): frames the image in brilliant white
  // on a fixed middle-grey surround, giving the eye a white + neutral reference
  // for judging tone and colour (as darktable's Ctrl+B mode). Persisted.
  colorAssessment: boolean;
  toggleColorAssessment: () => void;

}

export const createViewSlice: StateCreator<ViewSlice, [], [], ViewSlice> = (
  set,
  get,
) => ({
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
    try { const v = localStorage.getItem("sl_show_clipping"); return v && /^[0-7]$/.test(v) ? Number(v) : 0; } catch { return 0; }
  })() as ClippingMask,
  setShowClipping: (mode) => {
    set({ showClipping: mode });
    try { localStorage.setItem("sl_show_clipping", String(mode)); } catch {}
  },
  toggleClipping: () => {
    const next = get().showClipping === 0 ? 7 : 0;
    set({ showClipping: next });
    try { localStorage.setItem("sl_show_clipping", String(next)); } catch {}
  },

  proof: false,
  toggleProof: () => set({ proof: !get().proof }),

  colorAssessment: (() => {
    try { return localStorage.getItem("sl_color_assessment") === "1"; } catch { return false; }
  })(),
  toggleColorAssessment: () => {
    const next = !get().colorAssessment;
    set({ colorAssessment: next });
    try { localStorage.setItem("sl_color_assessment", next ? "1" : "0"); } catch {}
  },


});
