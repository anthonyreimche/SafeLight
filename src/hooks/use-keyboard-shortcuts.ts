import { useEffect } from "react";
import { useUIStore } from "@/state/ui-store";
import { useDevelopStore } from "@/state/develop-store";
import { toggleDockVisibility } from "@/extensions/dock";

const clampSize = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, Number(v.toFixed(3))));

export function useKeyboardShortcuts() {
  const setActiveModule = useUIStore((s) => s.setActiveModule);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      switch (e.key.toLowerCase()) {
        case "g":
          setActiveModule("library");
          break;
        case "d":
          setActiveModule("develop");
          break;
        case "tab":
          // Hide/show every dock panel; positions are restored exactly.
          e.preventDefault();
          toggleDockVisibility();
          break;
        case "f":
          if (!e.ctrlKey && !e.metaKey) {
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
