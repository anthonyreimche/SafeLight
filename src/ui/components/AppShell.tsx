// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { type ReactNode } from "react";
import { TopBar } from "./TopBar";
import { DockHost } from "@/extensions/dock";
import type { AppModule } from "@/catalog/types";

interface AppShellProps {
  module: AppModule;
  children: ReactNode;
  statusBar?: ReactNode;
}

// The shell is just top bar + dock + status bar. There are no fixed sidebars —
// every panel (folders, filters, edit stack, …) is a dockview panel placed by
// the module's layout, movable and floatable by the user.
export function AppShell({ module, children, statusBar }: AppShellProps) {
  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface-0">
        <DockHost module={module}>{children}</DockHost>
      </main>
      {statusBar && (
        <div className="flex h-6 items-center border-t border-border bg-surface-1 px-3 text-[10px] text-text-muted">
          {statusBar}
        </div>
      )}
    </div>
  );
}
