import { create } from "zustand";
import type { DevelopParams } from "@/catalog/types";

export interface Preset {
  id: string;
  name: string;
  params: DevelopParams;
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

interface PresetsState {
  presets: Preset[];
  add: (name: string, params: DevelopParams) => void;
  remove: (id: string) => void;
}

export const usePresetsStore = create<PresetsState>((set) => ({
  presets: loadFromStorage(),

  add(name, params) {
    set((s) => {
      const preset: Preset = {
        id: crypto.randomUUID(),
        name,
        params: structuredClone(params),
      };
      const presets = [...s.presets, preset];
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
