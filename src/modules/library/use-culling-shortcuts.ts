// Culling shortcuts, scoped to the Library (the hook is mounted by
// LibraryView, so it only listens while the grid is on screen). All combos are
// rebindable in Preferences ▸ Shortcuts; the defaults match Lightroom:
//
//   1-5 rating   0 clear   P pick   X reject   U unflag
//   6-9 color label        [ ] rotate          ← → prev / next
//
// Rating/flag/label apply to the whole current selection (or the active photo
// when nothing is multi-selected). Navigation walks the same filtered+sorted
// list the grid displays, so it never lands on a hidden photo.

import { useEffect } from "react";
import type { ColorLabel, FlagStatus } from "@/catalog/types";
import { useCatalogStore } from "@/state/catalog-store";
import { useUIStore } from "@/state/ui-store";
import {
  isEditableTarget,
  matchAction,
  shortcutsSuspended,
} from "@/state/keybindings-store";
import { visiblePhotos } from "./visible-photos";

const LABELS: Record<string, ColorLabel> = {
  "label.red": "red",
  "label.yellow": "yellow",
  "label.green": "green",
  "label.blue": "blue",
};

const FLAGS: Record<string, FlagStatus> = {
  "flag.pick": "pick",
  "flag.reject": "reject",
  "flag.unflag": "none",
};

export function useCullingShortcuts(): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (shortcutsSuspended()) return;

      // Shortcuts take priority: only bare keys defer to true text-entry
      // targets (so typing works); modifier combos always fire, and a focused
      // slider or checkbox never blocks anything.
      if (!(e.ctrlKey || e.metaKey || e.altKey) && isEditableTarget(e.target))
        return;

      // ↑/↓ are fixed aliases of prev/next so grid navigation feels natural.
      const action =
        matchAction(e, ["Library"]) ??
        (e.key === "ArrowUp" && !e.ctrlKey && !e.metaKey && !e.altKey
          ? "photo.prev"
          : e.key === "ArrowDown" && !e.ctrlKey && !e.metaKey && !e.altKey
            ? "photo.next"
            : e.key === "Backspace" && !e.ctrlKey && !e.metaKey && !e.altKey
              ? "photo.remove"
              : null);
      if (!action) return;

      const catalog = useCatalogStore.getState();
      const targetIds =
        catalog.selectedIds.size > 0
          ? [...catalog.selectedIds]
          : catalog.activePhotoId
            ? [catalog.activePhotoId]
            : [];

      if (action.startsWith("rate.")) {
        if (targetIds.length === 0) return;
        e.preventDefault();
        catalog.applyRating(targetIds, Number(action.slice(5)));
        return;
      }

      if (action in LABELS) {
        if (targetIds.length === 0) return;
        e.preventDefault();
        const color = LABELS[action];
        // Pressing the same color again clears it (toggle off).
        const ids = new Set(targetIds);
        const allHaveColor = catalog.photos
          .filter((p) => ids.has(p.id))
          .every((p) => p.colorLabel === color);
        catalog.applyColorLabel(targetIds, allHaveColor ? "none" : color);
        return;
      }

      if (action in FLAGS) {
        if (targetIds.length === 0) return;
        e.preventDefault();
        catalog.applyFlag(targetIds, FLAGS[action]);
        return;
      }

      if (action === "photo.remove") {
        if (targetIds.length === 0) return;
        e.preventDefault();
        const n = targetIds.length;
        const ok = window.confirm(
          `Remove ${n} photo${n === 1 ? "" : "s"} from the catalog? The original file${n === 1 ? "" : "s"} on disk won't be deleted.`,
        );
        if (ok) catalog.removePhotos(targetIds);
        return;
      }

      if (action === "photo.rotateCCW" || action === "photo.rotateCW") {
        if (targetIds.length === 0) return;
        e.preventDefault();
        catalog.rotatePhotos(targetIds, action === "photo.rotateCCW" ? -90 : 90);
        return;
      }

      if (action === "photo.prev" || action === "photo.next") {
        const ui = useUIStore.getState();
        const list = visiblePhotos(
          catalog.photos,
          ui.filter,
          ui.sortField,
          ui.sortDirection,
          ui.activeFolder,
        );
        if (list.length === 0) return;
        e.preventDefault();
        const back = action === "photo.prev";
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

    // Capture phase: shortcuts see the event before any component can
    // stopPropagation it away.
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);
}
