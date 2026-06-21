// Layout menu: switch the whole dock between registered layout presets
// (built-in "Classic" plus any extension-provided arrangements) and "Custom",
// the user's own saved per-module arrangement. Editing the dock while a
// preset is active automatically flips back to Custom.

import { useEffect, useRef, useState } from "react";
import { useRegistry } from "@/extensions/registry";
import {
  CUSTOM_LAYOUT,
  applyDockLayout,
  useLayoutStore,
  useUserLayouts,
} from "@/extensions/dock";
import { openPreferences } from "./PreferencesDialog";

export function LayoutMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const layouts = useRegistry((s) => s.layouts);
  const userLayouts = useUserLayouts((s) => s.layouts);
  const activeId = useLayoutStore((s) => s.activeId);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  const layoutList = Object.values(layouts).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const userList = Object.values(userLayouts).sort((a, b) =>
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
        Layout ▾
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 max-h-[70vh] w-56 overflow-y-auto rounded border border-border bg-surface-2 py-1 shadow-xl">
          <MenuItem
            checked={activeId === CUSTOM_LAYOUT}
            title="Your own arrangement. Any change you make to a layout is saved here."
            onClick={() => applyDockLayout(CUSTOM_LAYOUT)}
          >
            Custom
          </MenuItem>
          {userList.map((l) => (
            <MenuItem
              key={l.id}
              checked={activeId === l.id}
              onClick={() => applyDockLayout(l.id)}
            >
              {l.name}
            </MenuItem>
          ))}
          {layoutList.length > 0 && (
            <div className="my-1 border-t border-border-subtle" />
          )}
          {layoutList.map((l) => (
            <MenuItem
              key={l.id}
              checked={activeId === l.id}
              title={l.description}
              onClick={() => applyDockLayout(l.id)}
            >
              {l.name}
            </MenuItem>
          ))}
          <div className="my-1 border-t border-border-subtle" />
          <MenuItem
            checked={false}
            title="Add, rename or delete layouts in Preferences"
            onClick={() => {
              setOpen(false);
              openPreferences("Interface");
            }}
          >
            Manage layouts…
          </MenuItem>
        </div>
      )}
    </div>
  );
}

function MenuItem({
  checked,
  title,
  onClick,
  children,
}: {
  checked: boolean;
  title?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="flex w-full items-center gap-2 px-3 py-1 text-left text-[11px] text-text-secondary hover:bg-surface-3 hover:text-text-primary"
    >
      <span className="w-3 text-slider-fill">{checked ? "✓" : ""}</span>
      <span className="truncate">{children}</span>
    </button>
  );
}
