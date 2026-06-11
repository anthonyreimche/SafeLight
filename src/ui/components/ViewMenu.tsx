// View menu: toggle any registered panel as a floating/dockable window and
// switch themes. Everything listed here comes from the extension registry.

import { useEffect, useRef, useState } from "react";
import { useRegistry } from "@/extensions/registry";
import { toggleDockPanel, useDockStore } from "@/extensions/dock";
import { applyTheme, useThemeStore } from "@/extensions/themes";

export function ViewMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panels = useRegistry((s) => s.panels);
  const themes = useRegistry((s) => s.themes);
  const openPanels = useDockStore((s) => s.open);
  const activeTheme = useThemeStore((s) => s.activeId);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  const panelList = Object.values(panels).sort((a, b) =>
    a.title.localeCompare(b.title),
  );
  const themeList = Object.values(themes).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`rounded px-3 py-1 text-[11px] uppercase tracking-wider transition-colors ${
          open
            ? "bg-surface-3 text-text-primary"
            : "text-text-secondary hover:text-text-primary"
        }`}
      >
        View ▾
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 max-h-[70vh] w-56 overflow-y-auto rounded border border-border bg-surface-2 py-1 shadow-xl">
          <MenuLabel>Panels</MenuLabel>
          {panelList.map((p) => (
            <MenuItem
              key={p.id}
              checked={openPanels.includes(p.id)}
              onClick={() => toggleDockPanel(p.id)}
            >
              {p.title}
            </MenuItem>
          ))}
          <div className="my-1 border-t border-border-subtle" />
          <MenuLabel>Theme</MenuLabel>
          {themeList.map((t) => (
            <MenuItem
              key={t.id}
              checked={activeTheme === t.id}
              onClick={() => applyTheme(t.id)}
            >
              {t.name}
            </MenuItem>
          ))}
        </div>
      )}
    </div>
  );
}

function MenuLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pb-0.5 pt-1.5 text-[9px] uppercase tracking-widest text-text-muted">
      {children}
    </div>
  );
}

function MenuItem({
  checked,
  onClick,
  children,
}: {
  checked: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-1 text-left text-[11px] text-text-secondary hover:bg-surface-3 hover:text-text-primary"
    >
      <span className="w-3 text-accent">{checked ? "✓" : ""}</span>
      <span className="truncate">{children}</span>
    </button>
  );
}
