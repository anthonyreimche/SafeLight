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

function loadFromStorage(): Preset[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Preset[]) : [];
  } catch {
    return [];
  }
}

function saveToStorage(presets: Preset[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
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
  add: (
    name: string,
    params: Partial<DevelopParams>,
    group?: string,
    paramBag?: Record<string, unknown>,
  ) => void;
  /** Replace an existing preset's params/group in place (keeps id, name, position). */
  update: (
    id: string,
    params: Partial<DevelopParams>,
    group?: string,
    paramBag?: Record<string, unknown>,
  ) => void;
  /** Rename a preset, leaving its params/group/position untouched. */
  rename: (id: string, name: string) => void;
  /** Move a preset to another group (empty/undefined clears it to ungrouped). */
  setGroup: (id: string, group?: string) => void;
  remove: (id: string) => void;
}

export const usePresetsStore = create<PresetsState>((set) => ({
  presets: loadFromStorage(),

  add(name, params, group, paramBag) {
    set((s) => {
      const hasBag = paramBag && Object.keys(paramBag).length > 0;
      const preset: Preset = {
        id: crypto.randomUUID(),
        name,
        group: group?.trim() || undefined,
        params: structuredClone(params),
        ...(hasBag ? { paramBag: structuredClone(paramBag) } : {}),
      };
      const presets = [...s.presets, preset];
      saveToStorage(presets);
      return { presets };
    });
  },

  update(id, params, group, paramBag) {
    set((s) => {
      const hasBag = paramBag && Object.keys(paramBag).length > 0;
      const presets = s.presets.map((p) =>
        p.id === id
          ? {
              ...p,
              group: group?.trim() || undefined,
              params: structuredClone(params),
              paramBag: hasBag ? structuredClone(paramBag) : undefined,
            }
          : p,
      );
      saveToStorage(presets);
      return { presets };
    });
  },

  rename(id, name) {
    set((s) => {
      const trimmed = name.trim();
      if (!trimmed) return s;
      const presets = s.presets.map((p) => (p.id === id ? { ...p, name: trimmed } : p));
      saveToStorage(presets);
      return { presets };
    });
  },

  setGroup(id, group) {
    set((s) => {
      const next = group?.trim() || undefined;
      const presets = s.presets.map((p) => (p.id === id ? { ...p, group: next } : p));
      saveToStorage(presets);
      return { presets };
    });
  },

  remove(id) {
    set((s) => {
      const presets = s.presets.filter((p) => p.id !== id);
      saveToStorage(presets);
      return { presets };
    });
  },
}));
