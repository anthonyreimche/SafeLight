import { useEffect } from "react";
import type { AppModule } from "@/catalog/types";
import { useUIStore } from "@/state/ui-store";
import { useCatalogStore } from "@/state/catalog-store";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useWindowSync } from "@/hooks/use-window-sync";
import { detachedModule, MODULE_LABELS } from "@/state/detach";
import { AppShell } from "@/ui/components/AppShell";
import { LibraryView } from "@/modules/library/LibraryView";
import { DevelopView } from "@/modules/develop/DevelopView";
import { LoupeView } from "@/modules/loupe/LoupeView";
import { ExportView } from "@/modules/export/ExportView";

function renderModule(module: AppModule) {
  switch (module) {
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

export function App() {
  const activeModule = useUIStore((s) => s.activeModule);
  const detached = useUIStore((s) => s.detached);
  const loadCatalog = useCatalogStore((s) => s.loadCatalog);

  useKeyboardShortcuts();
  useWindowSync();

  useEffect(() => {
    loadCatalog();
  }, [loadCatalog]);

  // A detached window is dedicated to a single module.
  const dm = detachedModule();
  if (dm) return renderModule(dm);

  // In the main window, a module that's popped out lives in its own window.
  if (detached.has(activeModule)) {
    return (
      <AppShell>
        <div className="flex flex-1 items-center justify-center text-center text-text-muted">
          <p className="text-sm">
            {MODULE_LABELS[activeModule]} is open in a separate window.
          </p>
        </div>
      </AppShell>
    );
  }

  return renderModule(activeModule);
}
