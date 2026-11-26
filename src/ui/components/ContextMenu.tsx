// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useEffect, useLayoutEffect, useRef, useState, type JSX, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { pushEscapeHandler } from "@/ui/escape-stack";
import { uiZoom } from "@/ui/frame-point";
import { MENU_SURFACE } from "@/ui/floating";
import { handleMenuKeyDown } from "@/ui/menu-keys";

export interface ContextMenuItem {
  label: string;
  /** A small glyph before the label (about 14 px); decorative, so the label
   *  alone names the item. Needs Safelight 3.2.8. */
  icon?: ReactNode;
  onClick: () => void;
  /** Render in the red danger colour (e.g. Remove). */
  danger?: boolean;
  disabled?: boolean;
  /** Tooltip, shown on hover even when the item is disabled (say why it is).
   *  Needs Safelight 3.2.8. */
  title?: string;
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
 *  the enabled items, typing jumps to one, Enter or Space runs one, and
 *  closing hands focus back. */
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
        className={`sl-enter-fade absolute min-w-[180px] overflow-hidden py-1 text-[11px] ${MENU_SURFACE}`}
        style={{ left: pos.x, top: pos.y }}
        onKeyDown={(e) => handleMenuKeyDown(ref.current, e, "vertical")}
      >
        {items.map((item, i) =>
          item === "separator" ? (
            <div
              key={`sep-${i}`}
              role="separator"
              className="my-1 border-t border-border"
            />
          ) : (
            <button
              key={item.label}
              role="menuitem"
              disabled={item.disabled}
              title={item.title}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left disabled:cursor-not-allowed disabled:opacity-40 ${
                item.danger
                  ? "text-text-secondary hover:bg-danger hover:text-on-danger"
                  : "text-text-secondary hover:bg-surface-3 hover:text-text-primary"
              }`}
              onClick={() => {
                item.onClick();
                onClose();
              }}
            >
              {item.icon !== undefined && (
                <span aria-hidden="true" className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                  {item.icon}
                </span>
              )}
              {item.label}
            </button>
          ),
        )}
      </div>
    </div>,
    document.body,
  );
}
