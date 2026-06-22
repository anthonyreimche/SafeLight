// Culling shortcuts, scoped to the Library (the hook is mounted by
// LibraryView, so it only listens while the grid is on screen). All combos are
// rebindable in Preferences ▸ Shortcuts; the defaults match Lightroom:
//
//   1-5 rating   0 clear   P pick   X reject   U unflag
//   6-9 color label        [ ] rotate
//   ← → prev / next         ↑ ↓ up / down a grid row
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
import { moveActivePhoto, visibleList } from "./photo-navigation";
import { getSettings } from "@/state/settings-store";

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

      // Ctrl/Cmd+A selects every photo currently shown (active folder + filters),
      // not the whole catalog. Skip when a text field is focused so its native
      // select-all still works.
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        !e.shiftKey &&
        (e.key === "a" || e.key === "A")
      ) {
        if (isEditableTarget(e.target)) return;
        e.preventDefault();
        useCatalogStore.getState().selectAll(visibleList().map((p) => p.id));
        return;
      }

      // ↑/↓ move a whole grid row (←/→ via photo.prev/next move one). The row
      // stride is the grid's live column count; it's 1 in list view, so ↑/↓
      // there walk one row at a time, exactly like ←/→.
      const bare = !e.ctrlKey && !e.metaKey && !e.altKey;
      if (bare && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        const cols = Math.max(1, useUIStore.getState().gridColumns);
        moveActivePhoto(e.key === "ArrowUp" ? -cols : cols);
        return;
      }

      const action =
        matchAction(e, ["Library"]) ??
        (e.key === "Backspace" && bare ? "photo.remove" : null);
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
        if (getSettings().confirmRemovePhotos) {
          const ok = window.confirm(
            `Remove ${n} photo${n === 1 ? "" : "s"} from the catalog? The original file${n === 1 ? "" : "s"} on disk won't be deleted.`,
          );
          if (!ok) return;
        }
        catalog.removePhotos(targetIds);
        return;
      }

      if (action === "photo.rotateCCW" || action === "photo.rotateCW") {
        if (targetIds.length === 0) return;
        e.preventDefault();
        catalog.rotatePhotos(targetIds, action === "photo.rotateCCW" ? -90 : 90);
        return;
      }

      if (action === "keyword.focus") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("sl-focus-keyword-input"));
        return;
      }

      if (action === "photo.prev" || action === "photo.next") {
        e.preventDefault();
        moveActivePhoto(action === "photo.prev" ? -1 : 1);
      }
    };

    // Capture phase: shortcuts see the event before any component can
    // stopPropagation it away.
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);
}
