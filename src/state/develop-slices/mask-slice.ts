// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The edits core makes to a mask's values: the ones the mask scope
// (mask-scope.tsx) hands a mask sub-panel, and the seeding of a sub-panel's
// values when one is added to a mask or taken off. The masks themselves, the
// tools that draw them and their selection are the Masking extension's. The
// edits write params directly and post nothing to other windows; they do NOT
// commit to history — commitEdit ends a gesture for undo. Composed in
// develop-store.ts; `DevelopState extends MaskSlice`, so the slice owns these
// members' types. The sharpening preview rides along.

import type { StateCreator } from "zustand";
import type { DevelopParams, Mask, MaskAdjustments } from "@/catalog/types";
import { defaultHSL, defaultMaskAdjustments, defaultToneCurves } from "@/catalog/types";
import { getParamDescriptor } from "@/extensions/param-registry";

// Classifier for MaskPanelContribution.owns entries. Qualified extension keys
// always contain a dot ("stage.key"), so they can't collide with these.
const MASK_ADJ_KEYS = new Set(Object.keys(defaultMaskAdjustments()));

/** Whether a mask sub-panel's owned key lives in the mask's bag: an extension
 *  param, rather than a core adjustment or block. */
export function isMaskBagKey(key: string): boolean {
  return !MASK_ADJ_KEYS.has(key) && key !== "hsl" && key !== "toneCurve";
}

// Route each owned value to where it lives on the mask: adjustment fields are
// zeroed either way (0 is their default), the structured blocks are seeded
// with fresh defaults or stripped, and extension keys are restored to their
// registered defaults or deleted from the bag. An unregistered extension key
// has no known default, so seeding it is a delete too — nothing is invented.
function applyOwnedValues(
  s: MaskSlice,
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
  // Sharpening preview shown while Alt/Ctrl-dragging a Detail-panel sharpening
  // slider: 0 = off, 1 = masking, 2 = detail, 3 = luminance. Transient (not
  // persisted, not broadcast).
  sharpenViz: number;
  setSharpenViz: (mode: number) => void;

  // Mask value edits (persisted; commitEdit ends a gesture for undo).
  updateMask: (id: string, patch: Partial<Mask>) => void;
  updateMaskAdj: (id: string, patch: Partial<MaskAdjustments>) => void;
  // Merge into the mask's extension-param bag; undefined values delete keys.
  updateMaskBag: (id: string, patch: Record<string, unknown>) => void;
  // Apply a mask sub-panel's `owns` list (PanelContribution.mask.owns): seed
  // writes each owned value's default (sub-panel added, or mask reset); clear
  // zeroes the adjustments and strips blocks / bag keys (sub-panel removed).
  seedMaskPanelValues: (maskId: string, owns: readonly string[]) => void;
  clearMaskPanelValues: (maskId: string, owns: readonly string[]) => void;
}

export const createMaskSlice: StateCreator<MaskSlice & { params: DevelopParams }, [], [], MaskSlice> = (
  set,
  get,
) => ({
  sharpenViz: 0,
  setSharpenViz: (sharpenViz) => set({ sharpenViz }),

  // undefined values delete their key so cleared blocks (e.g. hsl) don't persist
  // as explicit-undefined properties through structured-clone, mirroring updateMaskBag.
  updateMask(id, patch) {
    set((s) => ({
      params: {
        ...s.params,
        masks: s.params.masks.map((m) => {
          if (m.id !== id) return m;
          const next = { ...m, ...patch } as unknown as Record<string, unknown>;
          for (const [key, value] of Object.entries(patch)) {
            if (value === undefined) delete next[key];
          }
          return next as unknown as Mask;
        }),
      },
    }));
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
  },

  seedMaskPanelValues(maskId, owns) {
    applyOwnedValues(get(), maskId, owns, "seed");
  },

  clearMaskPanelValues(maskId, owns) {
    applyOwnedValues(get(), maskId, owns, "clear");
  },
});
