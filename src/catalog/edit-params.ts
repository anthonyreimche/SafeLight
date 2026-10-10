// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { DevelopParams } from "./types";
import { freshParams, normalizeParams } from "./types";
import { catalogStorage } from "./storage";
import { historyCursor } from "./history-cursor";
import { normalizeParamBag } from "@/extensions/param-registry";

// The saved develop params for a photo — the current point in its edit history,
// or fresh defaults at the current process version if it was never edited.
// The Library histogram uses this; Export reads the same edit through loadSavedEdit.
export async function loadSavedParams(photoId: string, asShotTemperature?: number): Promise<DevelopParams> {
  return (await loadSavedEdit(photoId, asShotTemperature)).params;
}

export interface SavedEdit {
  params: DevelopParams;
  /** Extension-contributed processing-stage params (e.g. denoise). */
  paramBag: Record<string, unknown>;
}

// Both the develop params and the contributed param bag in one storage read, so
// Export reproduces extension stages (denoise, …) exactly as Develop.
export async function loadSavedEdit(photoId: string, asShotTemperature?: number): Promise<SavedEdit> {
  const edit = await catalogStorage().getEditState(photoId);
  if (edit && edit.stack.length > 0) {
    // The stored cursor may be unusable; resolve it as Develop does on open.
    const snap = edit.stack[historyCursor(edit.currentIndex, edit.stack.length)];
    return { params: normalizeParams(snap.params), paramBag: normalizeParamBag(snap.paramBag) };
  }
  return {
    params: freshParams(asShotTemperature),
    paramBag: {},
  };
}
