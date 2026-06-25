// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Shared chrome for the app's window-style pop-ups (Preferences, Extensions,
// and any future "window" dialog): a dimmed backdrop that closes on outside
// click, a centered surface, and a titlebar you can drag the whole window by.
// Centralised so every such window behaves identically — drag, sizing, close.
// (The small single-purpose confirm dialogs — preset rename/delete, lens picker
// — are a separate lightweight pattern and intentionally don't use this.)

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { getSettings, useSettings } from "@/state/settings-store";

// What counts as a tab stop inside the dialog, for the focus trap.
const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

interface ModalWindowProps {
  title: string;
  onClose: () => void;
  /** Extra controls shown right-aligned in the titlebar, before the close × —
   *  e.g. a search box. */
  titlebar?: ReactNode;
  /** Override the surface box classes (size/border/etc). Defaults to the
   *  standard 960×640 window. */
  boxClassName?: string;
  children: ReactNode;
}

const DEFAULT_BOX =
  "flex h-[640px] max-h-[90vh] w-[960px] max-w-[94vw] flex-col overflow-hidden rounded-lg border border-border bg-surface-1 shadow-2xl";

export function ModalWindow({ title, onClose, titlebar, boxClassName, children }: ModalWindowProps) {
  // Drag-to-move by the titlebar. `pos` is an offset from the centered resting
  // position. The component mounts fresh each time it opens (callers render it
  // only while open), so it always starts centered — no reset needed. clientX/Y
  // are visual px under the <body> UI-scale zoom while `transform: translate` is
  // layout px, so divide deltas by uiScale to track the pointer 1:1 (mirrors
  // frame-point.ts).
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const moveRef = useRef<{ sx: number; sy: number; bx: number; by: number } | null>(null);
  const onTitleDown = (e: React.PointerEvent) => {
    // Leave interactive titlebar controls (search box, close ×) to themselves.
    if ((e.target as HTMLElement).closest("input,button,a,select,textarea")) return;
    e.preventDefault();
    moveRef.current = { sx: e.clientX, sy: e.clientY, bx: pos.x, by: pos.y };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onTitleMove = (e: React.PointerEvent) => {
    const m = moveRef.current;
    if (!m) return;
    const z = getSettings().uiScale || 1;
    setPos({ x: m.bx + (e.clientX - m.sx) / z, y: m.by + (e.clientY - m.sy) / z });
  };
  const onTitleUp = (e: React.PointerEvent) => {
    if (!moveRef.current) return;
    moveRef.current = null;
    (e.currentTarget as Element).releasePointerCapture(e.pointerId);
  };

  // Backdrop dim is user-tunable (Interface › Background dimming). 0 leaves the
  // app fully visible behind the window; the backdrop still catches the
  // outside-click-to-close because it's painted (transparent black), not absent.
  const dim = useSettings((s) => s.windowDim);

  // Accessible dialog: name it by its titlebar, move focus in on open, trap Tab
  // inside while open, and restore focus to the trigger on close (WCAG 2.4.3 /
  // 2.1.2). Esc is handled by callers via the escape stack, not here.
  const titleId = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const box = boxRef.current;
    // Respect any child autoFocus (e.g. a search box); only pull focus to the
    // dialog itself when nothing inside has claimed it.
    if (box && !box.contains(document.activeElement)) box.focus();
    return () => prev?.focus?.();
  }, []);
  const onBoxKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const box = boxRef.current;
    if (!box) return;
    const items = Array.from(
      box.querySelectorAll<HTMLElement>(FOCUSABLE),
    ).filter((el) => el.offsetParent !== null || el === box);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === box)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ backgroundColor: `rgba(0, 0, 0, ${dim})` }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onBoxKeyDown}
        className={`${boxClassName ?? DEFAULT_BOX} outline-none`}
        style={{ transform: pos.x || pos.y ? `translate(${pos.x}px, ${pos.y}px)` : undefined }}
      >
        <div
          className="flex h-[38px] shrink-0 cursor-move touch-none select-none items-center gap-3 border-b border-border bg-surface-2 px-3"
          onPointerDown={onTitleDown}
          onPointerMove={onTitleMove}
          onPointerUp={onTitleUp}
        >
          <span
            id={titleId}
            className="text-[11px] font-semibold uppercase tracking-widest text-text-secondary"
          >
            {title}
          </span>
          <div className="ml-auto flex items-center gap-3">
            {titlebar}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded px-1.5 text-[14px] leading-none text-text-muted hover:text-text-primary"
            >
              ×
            </button>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}
