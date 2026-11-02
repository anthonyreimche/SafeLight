// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { create } from "zustand";
import type { DevelopParams } from "@/catalog/types";

export interface Preset {
  id: string;
  name: string;
  /** Optional group/folder name. Presets without a group render ungrouped. */
  group?: string;
  /** Only the adjustments this preset carries. Applying merges these over the
   *  photo's current params (Lightroom-style partial presets), so a preset can
   *  hold as little as a single slider. Older full-snapshot presets simply carry
   *  every key. */
  params: Partial<DevelopParams>;
  /** Extension-contributed processing-stage params (e.g. denoise), keyed by
   *  qualified key. Stored whole; merged over the photo's current bag on apply.
   *  Absent on older presets and on file-imported presets. */
  paramBag?: Record<string, unknown>;
}

const STORAGE_KEY = "safelight-presets";

/** A stored payload, or null if it isn't a preset list. Anything else — a stray
 *  object, a truncated write — would otherwise reach the panel as a non-array and
 *  take the whole Develop sidebar down on its first .map(). */
function parsePresets(raw: string): Preset[] | null {
  try {
    const stored: unknown = JSON.parse(raw);
    return Array.isArray(stored) ? (stored as Preset[]) : null;
  } catch {
    return null;
  }
}

/** An unreadable library is kept under a side key so the empty list we fall back
 *  to can't destroy it when the first preset is saved over the original key. */
function backUpUnreadable(raw: string): void {
  try {
    localStorage.setItem(`${STORAGE_KEY}.unreadable-${Date.now()}`, raw);
  } catch {}
}

function loadFromStorage(): Preset[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const presets = parsePresets(raw);
    if (presets) return presets;
    backUpUnreadable(raw);
  } catch {}
  return [];
}

/** True when the list reached storage. A full quota is the usual failure. */
function saveToStorage(presets: Preset[]): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
    return true;
  } catch {
    return false;
  }
}

/** Return `base` if no preset uses it, else the first free "`base` N" suffix.
 *  Comparison is case-insensitive, matching the panel's collision check. */
export function nextAvailableName(presets: Preset[], base: string): string {
  const taken = new Set(presets.map((p) => p.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

interface PresetsState {
  presets: Preset[];
  /** Returns false, leaving the list unchanged, when the preset couldn't be saved
   *  (storage full): it would otherwise vanish on the next launch. */
  add: (
    name: string,
    params: Partial<DevelopParams>,
    group?: string,
    paramBag?: Record<string, unknown>,
  ) => boolean;
  /** Replace an existing preset's params/group in place (keeps id, name, position).
   *  Returns false, leaving the preset as it was, when the change couldn't be saved. */
  update: (
    id: string,
    params: Partial<DevelopParams>,
    group?: string,
    paramBag?: Record<string, unknown>,
  ) => boolean;
  /** Rename a preset, leaving its params/group/position untouched. */
  rename: (id: string, name: string) => void;
  /** Move a preset to another group (empty/undefined clears it to ungrouped). */
  setGroup: (id: string, group?: string) => void;
  remove: (id: string) => void;
}

export const usePresetsStore = create<PresetsState>((set, get) => {
  /** Adopt `presets` only if they could be saved, so memory never runs ahead of disk. */
  const commit = (presets: Preset[]): boolean => {
    if (!saveToStorage(presets)) return false;
    set({ presets });
    return true;
  };

  return {
    presets: loadFromStorage(),

    add(name, params, group, paramBag) {
      const hasBag = paramBag && Object.keys(paramBag).length > 0;
      const preset: Preset = {
        id: crypto.randomUUID(),
        name,
        group: group?.trim() || undefined,
        params: structuredClone(params),
        ...(hasBag ? { paramBag: structuredClone(paramBag) } : {}),
      };
      return commit([...get().presets, preset]);
    },

    update(id, params, group, paramBag) {
      const hasBag = paramBag && Object.keys(paramBag).length > 0;
      return commit(
        get().presets.map((p) =>
          p.id === id
            ? {
                ...p,
                group: group?.trim() || undefined,
                params: structuredClone(params),
                paramBag: hasBag ? structuredClone(paramBag) : undefined,
              }
            : p,
        ),
      );
    },

    rename(id, name) {
      const trimmed = name.trim();
      if (!trimmed) return;
      commit(get().presets.map((p) => (p.id === id ? { ...p, name: trimmed } : p)));
    },

    setGroup(id, group) {
      const next = group?.trim() || undefined;
      commit(get().presets.map((p) => (p.id === id ? { ...p, group: next } : p)));
    },

    remove(id) {
      commit(get().presets.filter((p) => p.id !== id));
    },
  };
});

/** Follow preset changes made in other windows. Call once at boot. */
export function initPresets(): void {
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY || e.newValue == null) return;
    const presets = parsePresets(e.newValue);
    if (presets) usePresetsStore.setState({ presets });
  });
}
