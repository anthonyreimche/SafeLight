import { useEffect } from "react";
import { useUIStore } from "@/state/ui-store";
import { useCatalogStore } from "@/state/catalog-store";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { LibraryView } from "@/modules/library/LibraryView";
import { DevelopView } from "@/modules/develop/DevelopView";
import { LoupeView } from "@/modules/loupe/LoupeView";
import { ExportView } from "@/modules/export/ExportView";

export function App() {
  const activeModule = useUIStore((s) => s.activeModule);
  const loadCatalog = useCatalogStore((s) => s.loadCatalog);

  useKeyboardShortcuts();

  useEffect(() => {
    loadCatalog();
  }, [loadCatalog]);

  // Detached loupe mode
  const params = new URLSearchParams(window.location.search);
  if (params.get("loupe") === "detached") {
    return <LoupeView />;
  }

  switch (activeModule) {
    case "library":
      return <LibraryView />;
    case "develop":
      return <DevelopView />;
    case "loupe":
      return <LoupeView />;
    case "export":
      return <ExportView />;
  }
}
