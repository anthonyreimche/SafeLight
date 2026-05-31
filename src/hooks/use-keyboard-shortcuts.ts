import { useEffect } from "react";
import { useUIStore } from "@/state/ui-store";

export function useKeyboardShortcuts() {
  const setActiveModule = useUIStore((s) => s.setActiveModule);
  const toggleLeftSidebar = useUIStore((s) => s.toggleLeftSidebar);
  const toggleRightSidebar = useUIStore((s) => s.toggleRightSidebar);

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
        case "e":
          setActiveModule("loupe");
          break;
        case "tab":
          e.preventDefault();
          toggleLeftSidebar();
          toggleRightSidebar();
          break;
        case "f":
          if (!e.ctrlKey && !e.metaKey) {
            document.documentElement.requestFullscreen?.();
          }
          break;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [setActiveModule, toggleLeftSidebar, toggleRightSidebar]);
}
