// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Shared top-bar dropdown: a labelled trigger button and a panel that closes
// on outside click or Escape. Consumers render their own MenuItem/MenuLabel
// entries and receive a `close` callback for items that dismiss the menu
// themselves.

import { useCallback, useEffect, useRef, useState } from "react";
import { pushEscapeHandler } from "@/ui/escape-stack";

export function TopBarMenu({
  label,
  children,
}: {
  label: string;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Dismissing the panel destroys whatever inside it had focus, so hand focus
  // back to the trigger (WCAG 2.4.3). Outside clicks are deliberately not
  // routed here — the pointer has already chosen where focus should land.
  const dismiss = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    const popEsc = pushEscapeHandler(dismiss);
    return () => {
      window.removeEventListener("pointerdown", close);
      popEsc();
    };
  }, [open, dismiss]);

  return (
    <div
      ref={ref}
      className="relative"
      // The app's global Escape handler drains the escape stack, but the menu
      // must also close from its own keydown so it works wherever it is used.
      onKeyDown={(e) => {
        if (open && e.key === "Escape") {
          e.preventDefault();
          dismiss();
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`rounded px-3 py-1 text-[11px] uppercase tracking-wider transition-colors ${
          open
            ? "bg-surface-3 text-text-primary"
            : "text-text-secondary hover:text-text-primary"
        }`}
      >
        {label}{" "}
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 max-h-[70vh] w-56 overflow-y-auto rounded border border-border bg-surface-2 py-1 shadow-xl">
          {children(dismiss)}
        </div>
      )}
    </div>
  );
}

export function MenuLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pb-0.5 pt-1.5 text-[9px] uppercase tracking-widest text-text-muted">
      {children}
    </div>
  );
}

export function MenuItem({
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
      type="button"
      // The tick is the only visual cue for state, so mirror it as a toggle
      // rather than letting it leak into the accessible name as a "✓" glyph.
      aria-pressed={checked}
      onClick={onClick}
      title={title}
      className="flex w-full items-center gap-2 px-3 py-1 text-left text-[11px] text-text-secondary hover:bg-surface-3 hover:text-text-primary"
    >
      <span aria-hidden="true" className="w-3 text-slider-fill">
        {checked ? "✓" : ""}
      </span>
      <span className="truncate">{children}</span>
    </button>
  );
}
