// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Shared top-bar dropdown: a labelled trigger button and a panel that closes
// on outside click or Escape. Consumers render their own MenuItem/MenuLabel
// entries and receive a `close` callback for items that dismiss the menu
// themselves.
//
// The menus behave as one menubar: at most one is open, and while one is open,
// hovering another trigger or pressing Left/Right moves to it, so browsing them
// takes no extra clicks.

import { useCallback, useEffect, useId, useRef } from "react";
import { create } from "zustand";
import { pushEscapeHandler } from "@/ui/escape-stack";
import { focusInitialMenuItem, handleMenuKeyDown } from "@/ui/menu-keys";
import { MENU_SURFACE } from "@/ui/floating";

/** `hovered`: the open menu was reached by hovering its trigger, so the click
 *  that usually follows the pointer there keeps it open rather than toggling
 *  it shut again. */
const useOpenMenu = create<{ id: string | null; hovered: boolean }>(() => ({
  id: null,
  hovered: false,
}));

const setOpenMenu = (id: string | null, hovered = false) =>
  useOpenMenu.setState({ id, hovered });

/** The trigger `step` places along from `from`, in document order, wrapping. */
function siblingTrigger(from: HTMLElement | null, step: 1 | -1): HTMLElement | null {
  const triggers = Array.from(
    document.querySelectorAll<HTMLElement>("[data-topbar-menu]"),
  );
  const at = from ? triggers.indexOf(from) : -1;
  if (at < 0 || triggers.length < 2) return null;
  return triggers[(at + step + triggers.length) % triggers.length];
}

export function TopBarMenu({
  label,
  children,
}: {
  label: string;
  children: (close: () => void) => React.ReactNode;
}) {
  const id = useId();
  const open = useOpenMenu((s) => s.id === id);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Dismissing the panel destroys whatever inside it had focus, so hand focus
  // back to the trigger (WCAG 2.4.3). Outside clicks are deliberately not
  // routed here — the pointer has already chosen where focus should land.
  const dismiss = useCallback(() => {
    if (useOpenMenu.getState().id === id) setOpenMenu(null);
    triggerRef.current?.focus();
  }, [id]);

  useEffect(() => {
    if (!open) return;
    focusInitialMenuItem(menuRef.current);
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node) && useOpenMenu.getState().id === id)
        setOpenMenu(null);
    };
    window.addEventListener("pointerdown", close);
    const popEsc = pushEscapeHandler(dismiss);
    return () => {
      window.removeEventListener("pointerdown", close);
      popEsc();
    };
  }, [open, id, dismiss]);

  useEffect(
    () => () => {
      if (useOpenMenu.getState().id === id) setOpenMenu(null);
    },
    [id],
  );

  const openSibling = (step: 1 | -1) => {
    const next = siblingTrigger(triggerRef.current, step);
    const nextId = next?.getAttribute("data-topbar-menu");
    if (nextId) setOpenMenu(nextId);
  };

  return (
    <div
      ref={ref}
      className="relative"
      // The app's global Escape handler drains the escape stack, but the menu
      // must also close from its own keydown so it works wherever it is used.
      onKeyDown={(e) => {
        if (!open) return;
        if (e.key === "Escape") {
          e.preventDefault();
          dismiss();
        } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          e.preventDefault();
          openSibling(e.key === "ArrowRight" ? 1 : -1);
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        data-topbar-menu={id}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (!open) setOpenMenu(id);
          else if (useOpenMenu.getState().hovered) setOpenMenu(id, false);
          else setOpenMenu(null);
        }}
        onPointerEnter={() => {
          const current = useOpenMenu.getState().id;
          if (current !== null && current !== id) setOpenMenu(id, true);
        }}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setOpenMenu(id);
          }
        }}
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
        <div
          ref={menuRef}
          role="menu"
          aria-label={label}
          onKeyDown={(e) => handleMenuKeyDown(menuRef.current, e, "vertical")}
          className={`sl-enter-fade absolute left-0 top-full z-50 mt-1 max-h-[70vh] w-56 overflow-y-auto py-1 ${MENU_SURFACE}`}
        >
          {children(dismiss)}
        </div>
      )}
    </div>
  );
}

export function MenuLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="presentation"
      className="px-3 pb-0.5 pt-1.5 text-[9px] uppercase tracking-widest text-text-muted"
    >
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
      role="menuitemcheckbox"
      // The tick is the only visual cue for state, so expose it as checked
      // state rather than letting it leak into the accessible name as a "✓".
      aria-checked={checked}
      onClick={onClick}
      title={title}
      className="flex w-full items-center gap-2 px-3 py-1 text-left text-[11px] text-text-secondary hover:bg-surface-3 hover:text-text-primary focus-visible:bg-surface-3 focus-visible:text-text-primary"
    >
      <span aria-hidden="true" className="w-3 text-slider-fill">
        {checked ? "✓" : ""}
      </span>
      <span className="truncate">{children}</span>
    </button>
  );
}
