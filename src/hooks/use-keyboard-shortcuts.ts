// Global shortcut handler. All combos come from the rebindable keybindings
// store (Preferences ▸ Shortcuts). Library-scoped culling shortcuts live in
// use-culling-shortcuts.ts, mounted only by LibraryView.

import { useEffect } from "react";
import { useUIStore } from "@/state/ui-store";
import { useDevelopStore } from "@/state/develop-store";
import { useCatalogStore } from "@/state/catalog-store";
import { toggleDockVisibility } from "@/extensions/dock";
import { getSettings } from "@/state/settings-store";
import { detachedModule } from "@/state/detach";
import {
  getBinding,
  isBareKey,
  isEditableTarget,
  matchAction,
  matchExtensionAction,
  shortcutsSuspended,
} from "@/state/keybindings-store";
import { togglePreferences } from "@/ui/components/PreferencesDialog";
import { toggleExtensions } from "@/ui/components/ExtensionsDialog";
import { popEscapeHandler } from "@/ui/escape-stack";

const clampSize = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, Number(v.toFixed(3))));

// Single-letter bindings for these are gated by the singleKeyShortcuts pref.
const GATED = new Set(["module.library", "module.develop", "view.fullscreen"]);

export function useKeyboardShortcuts() {
  const setActiveModule = useUIStore((s) => s.setActiveModule);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (shortcutsSuspended()) return;

      // Esc = universal "exit": close the topmost modal, else leave the active
      // develop tool mode (the panel "Done" buttons). Runs before the editable-
      // target gate so it still closes a dialog from a focused field; when there
      // is nothing to exit it doesn't consume the key (so a rename input's own
      // Esc-to-cancel still works).
      if (e.key === "Escape") {
        if (popEscapeHandler()) {
          e.preventDefault();
          return;
        }
        const d = useDevelopStore.getState();
        if (d.cropping) {
          e.preventDefault();
          d.setCropping(false);
        } else if (d.wbPicking) {
          e.preventDefault();
          d.setWbPicking(false);
        } else if (d.activeTool !== "none") {
          e.preventDefault();
          d.setActiveTool("none");
        }
        return;
      }

      // Shortcuts take priority everywhere. Only bare keys defer to true
      // text-entry targets (so typing still works); Ctrl/Alt combos fire even
      // while an input has focus, and a focused slider never blocks anything.
      const hasModifier = e.ctrlKey || e.metaKey || e.altKey;
      if (!hasModifier && isEditableTarget(e.target)) return;

      const inDevelop =
        useUIStore.getState().activeModule === "develop" ||
        detachedModule() === "develop";

      // [ / ] rotate the active photo in Develop too (Library mounts its own
      // handler; Develop only has this global one). Bare brackets bind solely to
      // rotate, so there's no conflict with the Shift+[ ] feather shortcuts.
      if (inDevelop) {
        const rot = matchAction(e, ["Library"]);
        if (rot === "photo.rotateCCW" || rot === "photo.rotateCW") {
          const cat = useCatalogStore.getState();
          const ids =
            cat.selectedIds.size > 0
              ? [...cat.selectedIds]
              : cat.activePhotoId
                ? [cat.activePhotoId]
                : [];
          if (ids.length > 0) {
            e.preventDefault();
            void cat.rotatePhotos(ids, rot === "photo.rotateCCW" ? -90 : 90);
          }
          return;
        }
      }

      const action =
        matchAction(e, ["General"]) ??
        (inDevelop ? matchAction(e, ["Develop"]) : null);
      if (!action) {
        // Extension-registered shortcuts fire after built-ins.
        const ext = matchExtensionAction(e);
        if (ext) { e.preventDefault(); ext.handler(); }
        return;
      }

      if (
        GATED.has(action) &&
        isBareKey(getBinding(action)) &&
        !getSettings().singleKeyShortcuts
      ) {
        return;
      }

      const ds = useDevelopStore.getState();
      // Tool-scoped Develop actions only fire while their mode is active; when
      // it isn't, let the key through instead of swallowing it.
      const modeActive: Record<string, boolean> = {
        "mask.delete":
          ds.activeTool === "mask" &&
          !!ds.selectedMaskId &&
          !!ds.selectedComponentId,
        "brush.featherDown": ds.activeTool === "mask",
        "brush.featherUp": ds.activeTool === "mask",
        "crop.cycleGuide": ds.cropping,
        "crop.flipGuide": ds.cropping,
      };
      if (action in modeActive && !modeActive[action]) return;

      // Matched = handled: beat the browser/OS default for the combo.
      e.preventDefault();

      switch (action) {
        case "app.preferences":
          togglePreferences();
          break;
        case "app.extensions":
          toggleExtensions();
          break;
        case "module.library":
          setActiveModule("library");
          break;
        case "module.develop":
          setActiveModule("develop");
          break;
        case "panels.toggle":
          // Hide/show every dock panel; positions are restored exactly.
          e.preventDefault();
          toggleDockVisibility();
          break;
        case "view.fullscreen":
          document.documentElement.requestFullscreen?.();
          break;
        case "develop.undo":
          e.preventDefault();
          ds.undo();
          break;
        case "develop.redo":
          e.preventDefault();
          ds.redo();
          break;
        case "develop.reset":
          e.preventDefault();
          if (ds.photoId) void ds.reset();
          break;
        case "brush.smaller":
        case "brush.larger": {
          // Shrink/grow the active brush, Lightroom-style.
          const dir = action === "brush.larger" ? 1 : -1;
          if (ds.activeTool === "mask" && ds.maskToolType === "brush") {
            ds.setBrushSize(clampSize(ds.brushSize + dir * 0.01, 0.01, 0.5));
          } else if (ds.activeTool === "retouch") {
            ds.setRetouchSize(clampSize(ds.retouchSize + dir * 0.005, 0.01, 0.3));
          }
          break;
        }
        case "brush.featherDown":
        case "brush.featherUp": {
          // Adjust the mask brush's feather in 0.05 steps (0..1).
          const dir = action === "brush.featherUp" ? 1 : -1;
          const next = Math.round((ds.brushFeather + dir * 0.05) * 100) / 100;
          ds.setBrushFeather(Math.max(0, Math.min(1, next)));
          break;
        }
        case "mask.delete":
          ds.removeComponent(ds.selectedMaskId!, ds.selectedComponentId!);
          ds.commitEdit("Delete Component");
          break;
        case "crop.cycleGuide":
          ds.cycleCropGuide();
          break;
        case "crop.flipGuide":
          ds.cycleCropGuideFlip();
          break;
      }
    };

    // Capture phase: shortcuts see the event before any component can
    // stopPropagation it away.
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [setActiveModule]);
}
