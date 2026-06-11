import { useEffect } from "react";
import type { AppModule } from "@/catalog/types";
import { useUIStore } from "@/state/ui-store";
import { useCatalogStore } from "@/state/catalog-store";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useWindowSync } from "@/hooks/use-window-sync";
import { detachedModule, MODULE_LABELS } from "@/state/detach";
import { AppShell } from "@/ui/components/AppShell";
import { PreferencesDialog } from "@/ui/components/PreferencesDialog";
import { LibraryView } from "@/modules/library/LibraryView";
import { DevelopView } from "@/modules/develop/DevelopView";

function renderModule(module: AppModule) {
  switch (module) {
    case "library":
      return <LibraryView />;
    case "develop":
      return <DevelopView />;
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
  if (dm)
    return (
      <>
        {renderModule(dm)}
        <PreferencesDialog />
      </>
    );

  // In the main window, a module that's popped out lives in its own window.
  if (detached.has(activeModule)) {
    return (
      <>
        <AppShell module={activeModule}>
          <div className="flex flex-1 items-center justify-center text-center text-text-muted">
            <p className="text-sm">
              {MODULE_LABELS[activeModule]} is open in a separate window.
            </p>
          </div>
        </AppShell>
        <PreferencesDialog />
      </>
    );
  }

  return (
    <>
      {renderModule(activeModule)}
      <PreferencesDialog />
    </>
  );
}
