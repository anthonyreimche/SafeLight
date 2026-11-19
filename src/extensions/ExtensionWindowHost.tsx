// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Draws the open extension window (api.registerWindow) in the shared window
// chrome the Extensions window uses. Mounted wherever the Extensions window is.

import { useEffect } from "react";
import { ErrorBoundary } from "@/ui/components/ErrorBoundary";
import { ModalWindow } from "@/ui/components/ModalWindow";
import { pushEscapeHandler } from "@/ui/escape-stack";
import { boundaryKey } from "./guard";
import { moduleEntry, useRegistry } from "./registry";
import { hideWindow, toggleWindowMaximized, useOpenWindow } from "./window-store";

export function ExtensionWindowHost() {
  const openId = useOpenWindow((s) => s.open);
  const win = useRegistry((s) => (openId === null ? undefined : moduleEntry(s.windows, openId)));
  const maximized = useOpenWindow((s) => openId !== null && !!s.maximized[openId]);
  const id = win?.id;

  // A window its extension took away while open stays closed when it comes back.
  useEffect(() => {
    if (openId !== null && id === undefined) hideWindow(openId);
  }, [openId, id]);

  useEffect(() => {
    if (id === undefined) return;
    return pushEscapeHandler(() => hideWindow(id));
  }, [id]);

  if (!win) return null;
  const { title, component: Content, maximizable } = win;

  return (
    <ModalWindow
      key={win.id}
      title={title}
      onClose={() => hideWindow(win.id)}
      {...(maximizable ? { maximized, onToggleMaximize: () => toggleWindowMaximized(win.id) } : {})}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
        <ErrorBoundary
          key={boundaryKey(win.id, Content)}
          what={`Window "${win.id}"`}
          className="p-3 text-[11px] text-danger"
        >
          <Content />
        </ErrorBoundary>
      </div>
    </ModalWindow>
  );
}
