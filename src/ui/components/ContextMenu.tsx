// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { uiZoom } from "@/ui/frame-point";

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  /** Render in the red danger color (e.g. Remove). */
  danger?: boolean;
  disabled?: boolean;
}

/** A horizontal divider between groups of items. */
export type ContextMenuEntry = ContextMenuItem | "separator";

interface Props {
  x: number;
  y: number;
  items: ContextMenuEntry[];
  onClose: () => void;
}

/** Generic right-click menu positioned at the cursor and clamped to the
 *  viewport. Closes on outside click, Escape, scroll, or selecting an item. */
export function ContextMenu({ x, y, items, onClose }: Props) {
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

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    // Capture phase: close even when the scroll happens inside a nested scroller.
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50"
      onMouseDown={onClose}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        ref={ref}
        role="menu"
        className="absolute min-w-[180px] overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] py-1 text-[11px] shadow-xl"
        style={{ left: pos.x, top: pos.y }}
        onMouseDown={(e) => e.stopPropagation()}
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
              disabled={item.disabled}
              className={`block w-full px-3 py-1.5 text-left disabled:cursor-not-allowed disabled:opacity-40 ${
                item.danger
                  ? "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-label-red)]"
                  : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
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
    </div>
  );
}
