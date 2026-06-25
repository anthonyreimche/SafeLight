// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { type ReactNode, useContext, useState } from "react";
import { DockPanelTitleCtx } from "@/extensions/dock";

const STORAGE_PREFIX = "sl_panel_";

function readPanelState(title: string, defaultOpen: boolean): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + title);
    if (raw === "1") return true;
    if (raw === "0") return false;
  } catch {}
  return defaultOpen;
}

function writePanelState(title: string, open: boolean) {
  try {
    localStorage.setItem(STORAGE_PREFIX + title, open ? "1" : "0");
  } catch {}
}

interface PanelProps {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}

export function Panel({ title, defaultOpen = true, children }: PanelProps) {
  const dockTitle = useContext(DockPanelTitleCtx);
  const [open, setOpen] = useState(() => readPanelState(title, defaultOpen));

  // Inside a dock panel of the same name, the tab already shows the title —
  // drop the redundant collapsible header and render the content directly.
  if (dockTitle != null && dockTitle.toLowerCase() === title.toLowerCase()) {
    return <div className="px-3 py-3">{children}</div>;
  }

  const toggle = () => {
    const next = !open;
    setOpen(next);
    writePanelState(title, next);
  };

  return (
    <div className="border-b border-border-subtle">
      <button
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between px-3 py-2 text-[11px] uppercase tracking-wider text-text-secondary hover:text-text-primary"
      >
        <span>{title}</span>
        <span className="text-text-muted" aria-hidden="true">{open ? "▴" : "▾"}</span>
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
}
