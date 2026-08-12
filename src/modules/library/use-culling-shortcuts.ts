// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Culling shortcuts, live while a photo surface is mounted: LibraryView mounts
// them for the grid, and an extension photo browser (the Filmstrip) can mount
// them in Develop through api.catalog.useCullingShortcuts, so a shoot can be
// culled without leaving the editor. All combos are rebindable in
// Preferences ▸ Shortcuts; the defaults match Lightroom:
//
//   1-5 rating   0 clear   P pick   X reject   U unflag
//   6-9 color label        [ ] rotate
//   ← → prev / next         ↑ ↓ up / down a grid row
//   - = thumbnail size
//
// Rating/flag/label apply to the whole current selection (or the active photo
// when nothing is multi-selected). Navigation walks the same filtered+sorted
// list the grid displays, so it never lands on a hidden photo.

import { useEffect } from "react";
import type { ColorLabel, FlagStatus } from "@/catalog/types";
import { useCatalogStore } from "@/state/catalog-store";
import { useDevelopStore } from "@/state/develop-store";
import { useUIStore } from "@/state/ui-store";
import {
  isEditableTarget,
  matchAction,
  shortcutsSuspended,
} from "@/state/keybindings-store";
import { confirmAndDeleteFromDisk } from "./delete-from-disk";
import { moveActivePhoto, visibleList } from "./photo-navigation";
import { revealPhoto } from "@/project/folder-ops";
import { isNativeFS } from "@/project/native-fs";
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

export interface CullingShortcutOptions {
  /** Handle the thumbnail-size actions (- / =), which step the Library grid's
   *  cell size. Surfaces whose cells are sized by their container (a filmstrip
   *  follows its rail) pass false and leave the keys alone. Default true. */
  sizeSteps?: boolean;
}

// One shared listener, ref-counted across surfaces: the grid and a Filmstrip can
// be on screen together (a develop panel floated into Library), and a listener
// per surface would rotate twice and step two photos per press. Size steps stay
// live while any mounted surface wants them.
let surfaces = 0;
let sizeStepSurfaces = 0;

/** Develop's global handler owns prev/next and rotate on its own, so those keys
 *  keep working with no photo surface open. While one IS mounted it owns them. */
export function cullingShortcutsMounted(): boolean {
  return surfaces > 0;
}

/** True while a Develop mask component is selected — Delete/Backspace then
 *  belongs to mask.delete, not to removing photos from the catalog. */
function maskOwnsDelete(): boolean {
  const d = useDevelopStore.getState();
  return d.activeTool === "mask" && !!d.selectedMaskId && !!d.selectedComponentId;
}

function handleCullingKey(e: KeyboardEvent): void {
  if (shortcutsSuspended()) return;

  // Shortcuts take priority: only bare keys defer to true text-entry targets
  // (so typing works); modifier combos always fire, and a focused slider or
  // checkbox never blocks anything.
  if (!(e.ctrlKey || e.metaKey || e.altKey) && isEditableTarget(e.target)) return;

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
  // stride is the grid's live column count; it's 1 in list view, so ↑/↓ there
  // walk one row at a time, exactly like ←/→.
  const bare = !e.ctrlKey && !e.metaKey && !e.altKey;
  if (bare && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    e.preventDefault();
    const cols = Math.max(1, useUIStore.getState().gridColumns);
    moveActivePhoto(e.key === "ArrowUp" ? -cols : cols);
    return;
  }

  // photo.remove carries altDef "Backspace", so matchAction resolves the
  // bare-Backspace alias (respecting any rebind) without a local fallback.
  const action = matchAction(e, ["Library"]);
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
    if (targetIds.length === 0 || maskOwnsDelete()) return;
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

  if (action === "photo.deleteDisk") {
    if (targetIds.length === 0 || maskOwnsDelete()) return;
    e.preventDefault();
    void confirmAndDeleteFromDisk(targetIds);
    return;
  }

  if (action === "photo.rotateCCW" || action === "photo.rotateCW") {
    if (targetIds.length === 0) return;
    e.preventDefault();
    catalog.rotatePhotos(targetIds, action === "photo.rotateCCW" ? -90 : 90);
    return;
  }

  if (action === "grid.smaller" || action === "grid.larger") {
    if (sizeStepSurfaces === 0) return;
    e.preventDefault();
    useUIStore.getState().stepGridSize(action === "grid.smaller" ? -1 : 1);
    return;
  }

  if (action === "keyword.focus") {
    e.preventDefault();
    window.dispatchEvent(new CustomEvent("sl-focus-keyword-input"));
    return;
  }

  if (action === "photo.rename") {
    const id = catalog.activePhotoId ?? targetIds[0];
    if (!id) return;
    e.preventDefault();
    // The photo surface owns the rename dialog; hand it the photo to edit.
    window.dispatchEvent(new CustomEvent("sl-rename-photo", { detail: { id } }));
    return;
  }

  if (action === "photo.reveal") {
    const id = catalog.activePhotoId ?? targetIds[0];
    if (!id || !isNativeFS()) return;
    e.preventDefault();
    void revealPhoto(id);
    return;
  }

  if (action === "photo.prev" || action === "photo.next") {
    // A focused slider owns its own arrow keys (isEditableTarget lets range
    // inputs through so Ctrl+Z still undoes after a drag).
    if (e.target instanceof HTMLInputElement && e.target.type === "range") return;
    e.preventDefault();
    moveActivePhoto(action === "photo.prev" ? -1 : 1);
  }
}

export function useCullingShortcuts(options: CullingShortcutOptions = {}): void {
  const sizeSteps = options.sizeSteps ?? true;

  useEffect(() => {
    if (sizeSteps) sizeStepSurfaces++;
    // Capture phase: shortcuts see the event before any component can
    // stopPropagation it away.
    if (surfaces++ === 0)
      window.addEventListener("keydown", handleCullingKey, true);
    return () => {
      if (sizeSteps) sizeStepSurfaces--;
      if (--surfaces === 0)
        window.removeEventListener("keydown", handleCullingKey, true);
    };
  }, [sizeSteps]);
}
