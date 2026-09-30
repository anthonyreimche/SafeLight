// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useEffect } from "react";
import type { ModuleId } from "@/catalog/types";
import { moduleEntry, moduleLabel, useRegistry } from "@/extensions/registry";
import { useExternalPluginsSettled } from "@/extensions/loader";
import { detachedModule } from "@/state/detach";
import { useUIStore } from "@/state/ui-store";
import { AppShell } from "./AppShell";
import { ErrorBoundary } from "./ErrorBoundary";

// Hosts an extension-registered module inside the app shell. An unknown id in
// the main window means the module's extension is gone (disabled, uninstalled):
// hand back to Library. In a detached window the extension may simply not have
// loaded yet, so the window waits, then reports, and keeps its re-attach control.
export function ModuleView({ id }: { id: ModuleId }) {
  const mod = useRegistry((s) => moduleEntry(s.modules, id));
  const settled = useExternalPluginsSettled((s) => s.settled);
  const setActiveModule = useUIStore((s) => s.setActiveModule);
  const detached = detachedModule() !== null;

  useEffect(() => {
    if (!mod && !detached) setActiveModule("library");
  }, [mod, detached, setActiveModule]);

  // The shells are keyed apart so the dock remounts, and seeds the module's
  // default layout, when the module registers under a waiting pop-out. The
  // boundaries are keyed by module so one module's crash never outlives it.
  if (mod) {
    const Main = mod.component;
    const Status = mod.statusBar;
    return (
      <AppShell
        key="ready"
        module={id}
        statusBar={
          Status ? (
            <ErrorBoundary
              key={id}
              what={`Module "${mod.label}" status bar`}
              className="text-red-400"
            >
              <Status />
            </ErrorBoundary>
          ) : undefined
        }
      >
        <ErrorBoundary
          key={id}
          what={`Module "${mod.label}"`}
          className="flex flex-1 items-center justify-center text-center text-sm text-red-400"
        >
          <Main />
        </ErrorBoundary>
      </AppShell>
    );
  }
  if (!detached) return null;
  return (
    <AppShell key="pending" module={id}>
      <div className="flex flex-1 items-center justify-center text-center text-text-muted">
        <p className="text-sm">
          {settled
            ? `${moduleLabel(id)} isn't available in this window. Enable its extension, or re-attach.`
            : `Waiting for the ${moduleLabel(id)} extension…`}
        </p>
      </div>
    </AppShell>
  );
}
