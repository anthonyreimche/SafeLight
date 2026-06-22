// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { DevelopParams } from "./types";
import { normalizeParams } from "./types";
import { catalogStorage } from "./storage";
import { normalizeParamBag } from "@/extensions/param-registry";

// The saved develop params for a photo — the current point in its edit history,
// or normalized defaults if it was never edited. Shared by Loupe preview
// rendering and Export so both show exactly what Develop persisted.
export async function loadSavedParams(photoId: string, asShotTemperature?: number): Promise<DevelopParams> {
  const edit = await catalogStorage().getEditState(photoId);
  if (edit && edit.stack.length > 0) {
    return normalizeParams(edit.stack[edit.currentIndex].params);
  }
  return normalizeParams(asShotTemperature ? { temperature: asShotTemperature } : undefined);
}

export interface SavedEdit {
  params: DevelopParams;
  /** Extension-contributed processing-stage params (e.g. denoise). */
  paramBag: Record<string, unknown>;
}

// Both the develop params and the contributed param bag in one storage read, so
// Loupe and Export reproduce extension stages (denoise, …) exactly as Develop.
export async function loadSavedEdit(photoId: string, asShotTemperature?: number): Promise<SavedEdit> {
  const edit = await catalogStorage().getEditState(photoId);
  if (edit && edit.stack.length > 0) {
    const snap = edit.stack[edit.currentIndex];
    return { params: normalizeParams(snap.params), paramBag: normalizeParamBag(snap.paramBag) };
  }
  return {
    params: normalizeParams(asShotTemperature ? { temperature: asShotTemperature } : undefined),
    paramBag: {},
  };
}
