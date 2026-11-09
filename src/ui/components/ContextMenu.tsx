// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useEffect, useLayoutEffect, useRef, useState, type JSX } from "react";
import { createPortal } from "react-dom";

import { pushEscapeHandler } from "@/ui/escape-stack";
import { uiZoom } from "@/ui/frame-point";

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  /** Render in the red danger colour (e.g. Remove). */
  danger?: boolean;
  disabled?: boolean;
}

/** A horizontal divider between groups of items. */
export type ContextMenuEntry = ContextMenuItem | "separator";

const enabledItems = (menu: HTMLElement | null): HTMLButtonElement[] =>
  Array.from(
    menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [],
  );

interface Props {
  x: number;
  y: number;
  items: ContextMenuEntry[];
  onClose: () => void;
}

/** Generic right-click menu positioned at the cursor and clamped to the
 *  viewport. Closes on outside click, Escape, scroll, or selecting an item.
 *  Focus moves to the first item on open; the arrow keys, Home and End walk
 *  the enabled items, Enter or Space runs one, and closing hands focus back. */
export function ContextMenu({ x, y, items, onClose }: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  // Clamp into the viewport once we know the menu's measured size. x/y arrive
  // as client (visual) px while CSS left/top position in layout px — under the
  // <body> UI-scale zoom those spaces differ by uiZoom (see frame-point.ts),
  // so both the point and the window extents must be divided into layout px.
  // offsetWidth/offsetHeight already measure in layout px.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const z = uiZoom();
    setPos({
      x: Math.max(0, Math.min(x / z, window.innerWidth / z - el.offsetWidth - 4)),
      y: Math.max(0, Math.min(y / z, window.innerHeight / z - el.offsetHeight - 4)),
    });
  }, [x, y]);

  // Pushed once: re-pushing on a new inline onClose would lift the menu above a
  // dialogue opened after it and steal that dialogue's Escape.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => pushEscapeHandler(() => onCloseRef.current()), []);

  useEffect(() => {
    // Capture phase: close even when the scroll happens inside a nested scroller.
    window.addEventListener("scroll", onClose, true);
    return () => window.removeEventListener("scroll", onClose, true);
  }, [onClose]);

  useEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    enabledItems(ref.current)[0]?.focus();
    // An item's action may have sent focus somewhere on purpose (a dialogue, a
    // field); only focus stranded on the body by the menu's removal goes back.
    return () => {
      if (document.activeElement === document.body || !document.activeElement) prev?.focus();
    };
  }, []);

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const list = enabledItems(ref.current);
    if (list.length === 0) return;
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const target =
      e.key === "ArrowDown"
        ? list[(at + 1) % list.length]
        : e.key === "ArrowUp"
          ? list[at <= 0 ? list.length - 1 : at - 1]
          : e.key === "Home"
            ? list[0]
            : e.key === "End"
              ? list[list.length - 1]
              : null;
    if (!target) return;
    e.preventDefault();
    target.focus();
  };

  // Portalled so a transformed ancestor (a centred floating panel) can't become
  // the fixed backdrop's containing block. React still bubbles portal events
  // through the owner tree, so presses stop here: a host that acts on
  // pointerdown (the dock header's drag) would otherwise preventDefault the
  // mousedown and read the release as its own click.
  return createPortal(
    <div
      data-testid="context-menu-backdrop"
      className="fixed inset-0 z-[160]"
      onPointerDown={(e) => {
        e.stopPropagation();
        if (!ref.current?.contains(e.target as Node)) onClose();
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        ref={ref}
        role="menu"
        className="absolute min-w-[180px] overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] py-1 text-[11px] shadow-xl"
        style={{ left: pos.x, top: pos.y }}
        onKeyDown={onMenuKeyDown}
      >
        {items.map((item, i) =>
          item === "separator" ? (
            <div
              key={`sep-${i}`}
              role="separator"
              className="my-1 border-t border-[var(--color-border)]"
            />
          ) : (
            <button
              key={item.label}
              role="menuitem"
              // The menu owns its bare keys: the culling shortcuts' ↑/↓ would
              // otherwise also step the active photo behind it.
              data-keyboard-capture=""
              disabled={item.disabled}
              className={`block w-full px-3 py-1.5 text-left disabled:cursor-not-allowed disabled:opacity-40 ${
                item.danger
                  ? "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-label-red)]"
                  : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text-primary)]"
              }`}
              onClick={() => {
                item.onClick();
                onClose();
              }}
            >
              {item.label}
            </button>
          ),
        )}
      </div>
    </div>,
    document.body,
  );
}
