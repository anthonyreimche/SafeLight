// Culling shortcuts, scoped to the Library (the hook is mounted
// by LibraryView, so it only listens while the grid is on screen):
//
//   1-5        set rating          0   clear rating
//   P pick     X reject     U unflag
//   6-9        color label (red / yellow / green / blue)
//   ← →        move to previous / next photo (also ↑ ↓)
//
// Rating/flag/label apply to the whole current selection (or the active photo
// when nothing is multi-selected). Navigation walks the same filtered+sorted
// list the grid displays, so it never lands on a hidden photo.

import { useEffect } from "react";
import type { ColorLabel, FlagStatus } from "@/catalog/types";
import { useCatalogStore } from "@/state/catalog-store";
import { useUIStore } from "@/state/ui-store";
import { visiblePhotos } from "./visible-photos";

const LABEL_KEYS: Record<string, ColorLabel> = {
  "6": "red",
  "7": "yellow",
  "8": "green",
  "9": "blue",
};

const FLAG_KEYS: Record<string, FlagStatus> = {
  p: "pick",
  x: "reject",
  u: "none",
};

export function useCullingShortcuts(): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      ) {
        return;
      }
      // Leave browser/OS combos and the global module shortcuts untouched.
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const catalog = useCatalogStore.getState();
      const targetIds =
        catalog.selectedIds.size > 0
          ? [...catalog.selectedIds]
          : catalog.activePhotoId
            ? [catalog.activePhotoId]
            : [];

      const key = e.key;

      if (/^[0-5]$/.test(key)) {
        if (targetIds.length === 0) return;
        e.preventDefault();
        catalog.applyRating(targetIds, Number(key));
        return;
      }

      if (key in LABEL_KEYS) {
        if (targetIds.length === 0) return;
        e.preventDefault();
        const color = LABEL_KEYS[key];
        // Pressing the same color again clears it (toggle off).
        const ids = new Set(targetIds);
        const allHaveColor = catalog.photos
          .filter((p) => ids.has(p.id))
          .every((p) => p.colorLabel === color);
        catalog.applyColorLabel(targetIds, allHaveColor ? "none" : color);
        return;
      }

      const flag = FLAG_KEYS[key.toLowerCase()];
      if (flag) {
        if (targetIds.length === 0) return;
        e.preventDefault();
        catalog.applyFlag(targetIds, flag);
        return;
      }

      if (key === "Delete" || key === "Backspace") {
        if (targetIds.length === 0) return;
        e.preventDefault();
        const n = targetIds.length;
        const ok = window.confirm(
          `Remove ${n} photo${n === 1 ? "" : "s"} from the catalog? The original file${n === 1 ? "" : "s"} on disk won't be deleted.`,
        );
        if (ok) catalog.removePhotos(targetIds);
        return;
      }

      if (key === "[" || key === "]") {
        if (targetIds.length === 0) return;
        e.preventDefault();
        catalog.rotatePhotos(targetIds, key === "[" ? -90 : 90);
        return;
      }

      if (
        key === "ArrowLeft" ||
        key === "ArrowRight" ||
        key === "ArrowUp" ||
        key === "ArrowDown"
      ) {
        const ui = useUIStore.getState();
        const list = visiblePhotos(
          catalog.photos,
          ui.filter,
          ui.sortField,
          ui.sortDirection,
        );
        if (list.length === 0) return;
        e.preventDefault();
        const back = key === "ArrowLeft" || key === "ArrowUp";
        const curIdx = catalog.activePhotoId
          ? list.findIndex((p) => p.id === catalog.activePhotoId)
          : -1;
        let nextIdx: number;
        if (curIdx === -1) {
          nextIdx = back ? list.length - 1 : 0;
        } else {
          nextIdx = Math.max(0, Math.min(list.length - 1, curIdx + (back ? -1 : 1)));
        }
        catalog.select(list[nextIdx].id);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
