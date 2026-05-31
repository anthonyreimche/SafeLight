import { type ReactNode, useState } from "react";

interface PanelProps {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}

export function Panel({ title, defaultOpen = true, children }: PanelProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border-b border-border-subtle">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-3 py-2 text-[11px] uppercase tracking-wider text-text-secondary hover:text-text-primary"
      >
        <span>{title}</span>
        <span className="text-text-muted">{open ? "▴" : "▾"}</span>
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
}
