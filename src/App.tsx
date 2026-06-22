// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useEffect } from "react";
import type { AppModule } from "@/catalog/types";
import { useUIStore } from "@/state/ui-store";
import { useCatalogStore } from "@/state/catalog-store";
import { useProjectStore } from "@/project/project-store";
import { getSettings } from "@/state/settings-store";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useWindowSync } from "@/hooks/use-window-sync";
import { detachedModule, MODULE_LABELS } from "@/state/detach";
import { isDevtoolsWindow } from "@/extensions/devtools/detach";
import { DevToolsWindow } from "@/extensions/devtools/DevToolsPanel";
import { AppShell } from "@/ui/components/AppShell";
import { PreferencesDialog } from "@/ui/components/PreferencesDialog";
import { ExtensionsDialog } from "@/ui/components/ExtensionsDialog";
import { LibraryView } from "@/modules/library/LibraryView";
import { DevelopView } from "@/modules/develop/DevelopView";
import { WelcomeView } from "@/modules/welcome/WelcomeView";
import { UpdateBanner } from "@/update/UpdateBanner";

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
  const root = useProjectStore((s) => s.root);
  const opening = useProjectStore((s) => s.opening);

  useKeyboardShortcuts();
  useWindowSync();

  // A detached window is dedicated to a single module, or to the Developer
  // Tools panel.
  const dm = detachedModule();
  const devtoolsWindow = isDevtoolsWindow();

  // Detached windows reopen the shared project automatically so they have data;
  // the main window instead lands on the welcome grid and opens on a click.
  useEffect(() => {
    if (dm) loadCatalog();
  }, [dm, loadCatalog]);

  // Main window only: optionally reopen the most-recent project on launch.
  // openLast() verifies permission silently and, if it can't reconnect (e.g. a
  // browser handle whose permission lapsed), leaves the welcome grid in place
  // rather than blocking startup. Runs once on mount.
  useEffect(() => {
    if (dm || devtoolsWindow) return;
    if (!getSettings().restoreLastProject) return;
    void useProjectStore.getState().openLast();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The Developer Tools window renders only the panel — no module, no project.
  if (devtoolsWindow) return <DevToolsWindow />;

  if (dm)
    return (
      <>
        {renderModule(dm)}
        <PreferencesDialog />
        <ExtensionsDialog />
        <UpdateBanner />
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
        <ExtensionsDialog />
        <UpdateBanner />
      </>
    );
  }

  // Main window, no project open yet: the startup welcome grid.
  if (!root && !opening) {
    return (
      <>
        <WelcomeView />
        <PreferencesDialog />
        <ExtensionsDialog />
        <UpdateBanner />
      </>
    );
  }

  return (
    <>
      {renderModule(activeModule)}
      <PreferencesDialog />
      <ExtensionsDialog />
      <UpdateBanner />
    </>
  );
}
