// Global shortcut handler. All combos come from the rebindable keybindings
// store (Preferences ▸ Shortcuts). Library-scoped culling shortcuts live in
// use-culling-shortcuts.ts, mounted only by LibraryView.

import { useEffect } from "react";
import { useUIStore } from "@/state/ui-store";
import { useDevelopStore } from "@/state/develop-store";
import { toggleDockVisibility } from "@/extensions/dock";
import { getSettings } from "@/state/settings-store";
import { detachedModule } from "@/state/detach";
import {
  getBinding,
  isBareKey,
  isEditableTarget,
  matchAction,
  shortcutsSuspended,
} from "@/state/keybindings-store";
import { togglePreferences } from "@/ui/components/PreferencesDialog";

const clampSize = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, Number(v.toFixed(3))));

// Single-letter bindings for these are gated by the singleKeyShortcuts pref.
const GATED = new Set(["module.library", "module.develop", "view.fullscreen"]);

export function useKeyboardShortcuts() {
  const setActiveModule = useUIStore((s) => s.setActiveModule);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (shortcutsSuspended()) return;

      // Shortcuts take priority everywhere. Only bare keys defer to true
      // text-entry targets (so typing still works); Ctrl/Alt combos fire even
      // while an input has focus, and a focused slider never blocks anything.
      const hasModifier = e.ctrlKey || e.metaKey || e.altKey;
      if (!hasModifier && isEditableTarget(e.target)) return;

      const inDevelop =
        useUIStore.getState().activeModule === "develop" ||
        detachedModule() === "develop";
      const action =
        matchAction(e, ["General"]) ??
        (inDevelop ? matchAction(e, ["Develop"]) : null);
      if (!action) return;

      if (
        GATED.has(action) &&
        isBareKey(getBinding(action)) &&
        !getSettings().singleKeyShortcuts
      ) {
        return;
      }

      // Matched = handled: beat the browser/OS default for the combo.
      e.preventDefault();

      const ds = useDevelopStore.getState();
      switch (action) {
        case "app.preferences":
          togglePreferences();
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
      }
    };

    // Capture phase: shortcuts see the event before any component can
    // stopPropagation it away.
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [setActiveModule]);
}
