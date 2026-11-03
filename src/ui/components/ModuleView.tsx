// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useEffect } from "react";
import type { ModuleId } from "@/catalog/types";
import {
  moduleEntry,
  moduleLabel,
  useModules,
  useRegistry,
} from "@/extensions/registry";
import { installMissingEssentials, useEssentialsMigration } from "@/extensions/essentials-migration";
import { useExternalPluginsSettled } from "@/extensions/loader";
import { detachedModule } from "@/state/detach";
import { useUIStore } from "@/state/ui-store";
import { AppShell } from "./AppShell";
import { ErrorBoundary } from "./ErrorBoundary";
import { TopBar } from "./TopBar";
import { openEssentials } from "./EssentialsNotice";

// Hosts an extension-registered module inside the app shell. An unknown id in
// the main window, once the installed extensions have loaded, means the
// module's extension is gone (disabled, uninstalled): hand over to the first
// other tab, or, with no module at all, keep the top bar over a pointer to the
// Extensions store. Before then it may only be loading after another module
// (Library after Develop), so the window keeps it and shows the top bar. In a detached window the extension
// may simply not have loaded yet, so the window waits, then reports, and keeps
// its re-attach control.
export function ModuleView({ id }: { id: ModuleId }) {
  const mod = useRegistry((s) => moduleEntry(s.modules, id));
  const fallback = useModules().find((m) => m.id !== id)?.id;
  const settled = useExternalPluginsSettled((s) => s.settled);
  const setActiveModule = useUIStore((s) => s.setActiveModule);
  const detached = detachedModule() !== null;

  useEffect(() => {
    if (!mod && !detached && settled && fallback) setActiveModule(fallback);
  }, [mod, detached, settled, fallback, setActiveModule]);

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
              className="text-danger"
            >
              <Status />
            </ErrorBoundary>
          ) : undefined
        }
      >
        <ErrorBoundary
          key={id}
          what={`Module "${mod.label}"`}
          className="flex flex-1 items-center justify-center text-center text-sm text-danger"
        >
          <Main />
        </ErrorBoundary>
      </AppShell>
    );
  }
  if (!detached) return settled && fallback ? null : <NoModules settled={settled} />;
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

/** The shell with no module to show. The note waits for the installed
 *  extensions, so it doesn't flash while Library and Develop are loading. The
 *  button installs them from the official list built into the app, for a first
 *  run that couldn't reach the network. */
function NoModules({ settled }: { settled: boolean }) {
  const status = useEssentialsMigration((s) => s.status);
  const installing = status === "installing";
  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-surface-0 text-center text-text-muted">
        {settled && (
          <>
            <p className="text-sm">Library and Develop aren't installed.</p>
            <p className="max-w-sm text-xs">
              {status === "failed"
                ? "They couldn't be downloaded. Check your internet connection and try again."
                : "They are Safelight's own extensions and download once, so this needs an internet connection."}
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => void installMissingEssentials()}
                disabled={installing}
                className="rounded bg-slider-fill px-3 py-1 text-[11px] font-medium text-on-accent hover:opacity-90 disabled:opacity-50"
              >
                {installing ? "Installing…" : "Install the essentials"}
              </button>
              <button
                onClick={openEssentials}
                className="rounded border border-border px-3 py-1 text-[11px] text-text-primary hover:bg-surface-3"
              >
                Open Extensions
              </button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
