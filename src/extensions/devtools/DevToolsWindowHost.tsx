// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The popped-out Developer Tools window (?devtools=1). It shows whichever panel
// is registered as core.devtools and nothing of core's around it: the extension
// draws its own title bar there. Until the installed extensions have loaded the
// window stays blank, so the note doesn't flash while Developer Tools starts.

import { useRegistry } from "../registry";
import { useExternalPluginsSettled } from "../loader";
import { ErrorBoundary } from "@/ui/components/ErrorBoundary";
import { DEVTOOLS_PANEL_ID } from "./detach";

export function DevToolsWindowHost() {
  const panel = useRegistry((s) => s.panels[DEVTOOLS_PANEL_ID]);
  const settled = useExternalPluginsSettled((s) => s.settled);
  if (panel) {
    const Panel = panel.component;
    return (
      <ErrorBoundary what={`Panel "${DEVTOOLS_PANEL_ID}"`} className="p-3 text-[11px] text-danger">
        <Panel />
      </ErrorBoundary>
    );
  }
  return (
    <div className="flex h-screen items-center justify-center bg-surface-1 px-6 text-center text-[11px] text-text-muted">
      {settled && <p>Developer Tools isn't installed.</p>}
    </div>
  );
}
