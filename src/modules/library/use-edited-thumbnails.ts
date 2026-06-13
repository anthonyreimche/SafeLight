import { useCallback, useEffect, useRef } from "react";
import type { CatalogPhoto, DevelopParams } from "@/catalog/types";
import { normalizeParams } from "@/catalog/types";
import { catalogStorage } from "@/catalog/storage";
import { onBroadcast } from "@/state/broadcast";
import { useEditedThumbs } from "@/state/edited-thumbnails";
import { renderEditedThumbnail } from "@/rendering/thumbnail-renderer";

const POLL_INTERVAL = 1000;

// Signature of params with no visible edits — these photos keep their original
// thumbnail and are never rendered.
const DEFAULT_SIG = JSON.stringify(normalizeParams(undefined));

const sigOf = (p: DevelopParams) => JSON.stringify(p);

interface Edit {
  params: DevelopParams;
  sig: string;
}

// Keeps the Library's grid/list thumbnails in sync with each photo's saved
// develop edits. Runs only while this hook is mounted (i.e. the Library view is
// visible), rendering one thumbnail at a time on the shared offscreen WebGL
// renderer with a small gap between each, so it stays light on a big catalog.
export function useEditedThumbnails(visible: CatalogPhoto[]) {
  // Latest known edit per photo (from the DB on mount, then live broadcasts).
  const editsRef = useRef<Map<string, Edit>>(new Map());
  // `${id}:${sig}` we've already tried, so a failed render doesn't loop forever.
  const attemptedRef = useRef<Set<string>>(new Set());
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const pumpingRef = useRef(false);
  const mountedRef = useRef(true);
  const debounceRef = useRef<number | null>(null);

  // Drain the queue: render the next visible photo whose cached thumbnail is
  // missing or stale, then pause briefly and continue. Serialized via a guard.
  const pump = useCallback(async () => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    try {
      while (mountedRef.current) {
        const entries = useEditedThumbs.getState().entries;
        const next = visibleRef.current.find((p) => {
          const edit = editsRef.current.get(p.id);
          if (!edit) return false;
          if (entries[p.id]?.sig === edit.sig) return false;
          return !attemptedRef.current.has(`${p.id}:${edit.sig}`);
        });
        if (!next) break;

        const edit = editsRef.current.get(next.id)!;
        attemptedRef.current.add(`${next.id}:${edit.sig}`);

        try {
          // Render through the same decode/curve as Develop so edited grid
          // thumbnails match the Develop view (not the flat camera preview).
          const out = await renderEditedThumbnail(next, edit.params);
          // Skip a stale result if a newer edit arrived while we rendered.
          if (
            out &&
            mountedRef.current &&
            editsRef.current.get(next.id)?.sig === edit.sig
          ) {
            useEditedThumbs
              .getState()
              .put(next.id, URL.createObjectURL(out), edit.sig);
          }
        } catch {
          // Leave it on the original thumbnail; attempted-set avoids retrying.
        }
        await new Promise((r) => setTimeout(r, 40));
      }
    } finally {
      pumpingRef.current = false;
    }
  }, []);

  // Debounced pump, so a flurry of live edit-update messages (a Develop drag in
  // another window) collapses into a single render of the final state.
  const schedulePump = useCallback(() => {
    if (debounceRef.current != null) clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      void pump();
    }, 300);
  }, [pump]);

  // Seed known edits from the DB on mount, and track live edits via broadcast.
  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;

    catalogStorage().getAllEditStates().then((states) => {
      if (cancelled) return;
      for (const st of states) {
        const raw = st.stack[st.currentIndex]?.params;
        if (!raw) continue;
        const params = normalizeParams(raw);
        const sig = sigOf(params);
        if (sig !== DEFAULT_SIG) editsRef.current.set(st.photoId, { params, sig });
      }
      // Drop cached thumbnails for photos whose edits were since reset/removed,
      // so the grid reverts them to the original.
      const cached = useEditedThumbs.getState().entries;
      for (const id of Object.keys(cached)) {
        if (!editsRef.current.has(id)) useEditedThumbs.getState().drop(id);
      }
      void pump();
    });

    const off = onBroadcast((msg) => {
      if (msg.type !== "edit-update" || !msg.payload.photoId) return;
      const id = msg.payload.photoId;
      const params = normalizeParams(msg.payload.params);
      const sig = sigOf(params);
      if (sig === DEFAULT_SIG) {
        editsRef.current.delete(id);
        useEditedThumbs.getState().drop(id);
      } else {
        editsRef.current.set(id, { params, sig });
      }
      schedulePump();
    });

    return () => {
      cancelled = true;
      mountedRef.current = false;
      off();
      if (debounceRef.current != null) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [pump, schedulePump]);

  // Re-pump when the visible set changes (scroll/filter/sort/new photos).
  useEffect(() => {
    void pump();
  }, [visible, pump]);

  // Poll the DB every second so thumbnails update even when broadcasts are missed
  // (e.g. after returning from the Develop view in a separate window).
  useEffect(() => {
    const id = window.setInterval(async () => {
      if (!mountedRef.current) return;
      let changed = false;
      try {
        const states = await catalogStorage().getAllEditStates();
        for (const st of states) {
          const raw = st.stack[st.currentIndex]?.params;
          const params = normalizeParams(raw);
          const sig = sigOf(params);
          if (sig === DEFAULT_SIG) {
            if (editsRef.current.has(st.photoId)) {
              editsRef.current.delete(st.photoId);
              useEditedThumbs.getState().drop(st.photoId);
              changed = true;
            }
          } else {
            const existing = editsRef.current.get(st.photoId);
            if (!existing || existing.sig !== sig) {
              editsRef.current.set(st.photoId, { params, sig });
              changed = true;
            }
          }
        }
      } catch {
        // Storage not ready yet (e.g. no project open); skip this tick.
      }
      if (changed) void pump();
    }, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [pump]);
}
