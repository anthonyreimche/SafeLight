import { useEffect } from "react";
import { useUIStore } from "@/state/ui-store";
import { useDevelopStore } from "@/state/develop-store";
import { toggleDockVisibility } from "@/extensions/dock";
import { getSettings } from "@/state/settings-store";
import { togglePreferences } from "@/ui/components/PreferencesDialog";

const clampSize = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, Number(v.toFixed(3))));

export function useKeyboardShortcuts() {
  const setActiveModule = useUIStore((s) => s.setActiveModule);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ctrl/Cmd+, opens Preferences (works even while typing in an input).
      if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        e.preventDefault();
        togglePreferences();
        return;
      }

      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      const singleKeys = getSettings().singleKeyShortcuts;

      switch (e.key.toLowerCase()) {
        case "g":
          if (singleKeys) setActiveModule("library");
          break;
        case "d":
          if (singleKeys) setActiveModule("develop");
          break;
        case "tab":
          // Hide/show every dock panel; positions are restored exactly.
          e.preventDefault();
          toggleDockVisibility();
          break;
        case "f":
          if (singleKeys && !e.ctrlKey && !e.metaKey) {
            document.documentElement.requestFullscreen?.();
          }
          break;
        case "[":
        case "]": {
          // Shrink ([) / grow (]) the active brush, Lightroom-style.
          const ds = useDevelopStore.getState();
          const dir = e.key === "]" ? 1 : -1;
          if (ds.activeTool === "mask" && ds.maskToolType === "brush") {
            ds.setBrushSize(clampSize(ds.brushSize + dir * 0.01, 0.01, 0.5));
          } else if (ds.activeTool === "retouch") {
            ds.setRetouchSize(clampSize(ds.retouchSize + dir * 0.005, 0.01, 0.3));
          }
          break;
        }
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [setActiveModule]);
}
