// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Shared chrome for the app's window-style pop-ups (Preferences, Extensions,
// and any future "window" dialog): a dimmed backdrop that closes on outside
// click, a centered surface, and a titlebar you can drag the whole window by.
// Centralised so every such window behaves identically — drag, sizing, close,
// and (for callers that opt in) maximize/restore.
// (The small single-purpose confirm dialogs — preset rename/delete, lens picker
// — are a separate lightweight pattern and intentionally don't use this.)

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { getSettings, useSettings } from "@/state/settings-store";
import { trapTab } from "@/ui/focus-trap";
import { dragBarStyle, noDragStyle, useTitleBarOverlay } from "@/ui/window-chrome";

interface ModalWindowProps {
  title: string;
  onClose: () => void;
  /** Extra controls shown right-aligned in the titlebar, before the close × —
   *  e.g. a search box. */
  titlebar?: ReactNode;
  /** Override the surface box classes (size/border/etc). Defaults to the
   *  standard 960×640 window. Ignored while maximized. */
  boxClassName?: string;
  /** Fill the whole app window instead of floating centred. Only meaningful
   *  with onToggleMaximize; the caller owns (and may persist) the state. */
  maximized?: boolean;
  /** Shows a Maximize/Restore button beside the close × and makes a titlebar
   *  double-click toggle, like a desktop window. */
  onToggleMaximize?: () => void;
  children: ReactNode;
}

const DEFAULT_BOX =
  "flex h-[640px] max-h-[90vh] w-[960px] max-w-[94vw] flex-col overflow-hidden rounded-lg border border-border bg-surface-1 shadow-2xl";

const MAXIMIZED_BOX = "flex h-full w-full flex-col overflow-hidden bg-surface-1";

const isControl = (target: EventTarget) =>
  !!(target as HTMLElement).closest("input,button,a,select,textarea");

// Maximized, the titlebar covers the app's top bar and so becomes the OS title
// bar: the native window controls take its colour while it is mounted.
function TitleBarOverlay() {
  useTitleBarOverlay("--color-surface-2");
  return null;
}

// Diagonal arrows: outward to maximize, inward to restore.
function MaximizeIcon({ maximized }: { maximized: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {maximized ? (
        <path d="M10.5 1.5 7 5M7 2v3h3M1.5 10.5 5 7M2 7h3v3" />
      ) : (
        <path d="M7 5l3.5-3.5M7.5 1.5h3v3M5 7l-3.5 3.5M1.5 7.5v3h3" />
      )}
    </svg>
  );
}

export function ModalWindow({
  title,
  onClose,
  titlebar,
  boxClassName,
  maximized = false,
  onToggleMaximize,
  children,
}: ModalWindowProps) {
  // Drag-to-move by the titlebar. `pos` is an offset from the centered resting
  // position. The component mounts fresh each time it opens (callers render it
  // only while open), so it always starts centered — no reset needed. clientX/Y
  // are visual px under the <body> UI-scale zoom while `transform: translate` is
  // layout px, so divide deltas by uiScale to track the pointer 1:1 (mirrors
  // frame-point.ts).
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const moveRef = useRef<{ sx: number; sy: number; bx: number; by: number } | null>(null);
  // A maximized window has nowhere to move; the offset is kept for Restore.
  const onTitleDown = (e: React.PointerEvent) => {
    // Leave interactive titlebar controls (search box, close ×) to themselves.
    if (maximized || isControl(e.target)) return;
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
  // The browser has already dropped the capture by the time pointercancel
  // fires, so only the drag state needs clearing — without this the window
  // keeps following a button-less pointer until the next click.
  const onTitleCancel = () => {
    moveRef.current = null;
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
  const onBoxKeyDown = (e: React.KeyboardEvent) => trapTab(e, boxRef.current);

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
        data-maximized={maximized || undefined}
        className={`${maximized ? MAXIMIZED_BOX : (boxClassName ?? DEFAULT_BOX)} outline-none`}
        style={{
          transform: !maximized && (pos.x || pos.y) ? `translate(${pos.x}px, ${pos.y}px)` : undefined,
        }}
      >
        <div
          className={`flex h-[38px] shrink-0 touch-none select-none items-center gap-3 border-b border-border bg-surface-2 px-3 ${
            maximized ? "" : "cursor-move"
          }`}
          onPointerDown={onTitleDown}
          onPointerMove={onTitleMove}
          onPointerUp={onTitleUp}
          onPointerCancel={onTitleCancel}
          // Maximized, a double-click on the bar is the OS's (it maximizes the
          // app window, as on the top bar); the button restores.
          onDoubleClick={(e) => {
            if (onToggleMaximize && !isControl(e.target)) onToggleMaximize();
          }}
          style={maximized ? dragBarStyle : undefined}
        >
          {maximized && <TitleBarOverlay />}
          <span
            id={titleId}
            className="text-[11px] font-semibold uppercase tracking-widest text-text-secondary"
          >
            {title}
          </span>
          <div className="ml-auto flex items-center gap-3" style={maximized ? noDragStyle : undefined}>
            {titlebar}
            {onToggleMaximize && (
              <button
                type="button"
                onClick={onToggleMaximize}
                aria-label={maximized ? "Restore" : "Maximize"}
                title={maximized ? "Restore to a window" : "Maximize"}
                className="flex h-5 w-5 items-center justify-center rounded text-text-muted hover:text-text-primary"
              >
                <MaximizeIcon maximized={maximized} />
              </button>
            )}
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
