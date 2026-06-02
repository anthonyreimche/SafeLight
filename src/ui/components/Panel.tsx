import { type ReactNode, useState } from "react";

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
  const [open, setOpen] = useState(() => readPanelState(title, defaultOpen));

  const toggle = () => {
    const next = !open;
    setOpen(next);
    writePanelState(title, next);
  };

  return (
    <div className="border-b border-border-subtle">
      <button
        onClick={toggle}
        className="flex w-full items-center justify-between px-3 py-2 text-[11px] uppercase tracking-wider text-text-secondary hover:text-text-primary"
      >
        <span>{title}</span>
        <span className="text-text-muted">{open ? "▴" : "▾"}</span>
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
}
