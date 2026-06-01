import { create } from "zustand";

interface Entry {
  url: string; // object URL of the rendered edited thumbnail
  sig: string; // params signature it was rendered for (cache key)
}

interface EditedThumbState {
  entries: Record<string, Entry>;
  put: (id: string, url: string, sig: string) => void;
  drop: (id: string) => void;
}

// Session cache of edited-thumbnail object URLs, keyed by photo id. Lives at
// module scope so it survives Library remounts (tab switches) and is reused.
export const useEditedThumbs = create<EditedThumbState>((set, get) => ({
  entries: {},
  put: (id, url, sig) => {
    const prev = get().entries[id];
    if (prev && prev.url !== url) URL.revokeObjectURL(prev.url);
    set((s) => ({ entries: { ...s.entries, [id]: { url, sig } } }));
  },
  drop: (id) => {
    const prev = get().entries[id];
    if (!prev) return;
    URL.revokeObjectURL(prev.url);
    set((s) => {
      const next = { ...s.entries };
      delete next[id];
      return { entries: next };
    });
  },
}));

// Subscribe to just one photo's edited thumbnail URL (re-renders only that
// thumbnail when its edited version becomes ready).
export function useEditedThumbUrl(id: string): string | undefined {
  return useEditedThumbs((s) => s.entries[id]?.url);
}
