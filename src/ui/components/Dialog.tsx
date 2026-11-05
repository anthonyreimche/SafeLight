// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Shell for the small single-purpose dialogues (rename, copy settings): a dimmed
// backdrop that closes on outside click around a centred card. ModalWindow is
// the draggable, titled window; this is its lightweight sibling with the same
// modal contract — named by the caller's heading, focus moved in on open and
// handed back on close, Tab kept inside, Esc closes.
//
// App shortcuts stand down while it is up. Their capture-phase listeners
// would otherwise rate, flag or remove the selection behind it, since a
// focused checkbox or button isn't a text field they defer to. Paused, they
// no longer drain the escape stack either, so Esc is handled here.

import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { suspendShortcuts } from "@/state/keybindings-store";
import { trapTab } from "@/ui/focus-trap";

interface DialogProps {
  /** Id of the visible heading that names the dialogue. */
  labelledBy: string;
  onClose: () => void;
  /** Card classes (size, surface, border). */
  className: string;
  children: ReactNode;
}

export function Dialog({ labelledBy, onClose, className, children }: DialogProps) {
  const boxRef = useRef<HTMLDivElement>(null);

  // Runs before the caller's own effects, so a caller that focuses a field
  // still wins over the card itself.
  useEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const releaseShortcuts = suspendShortcuts();
    const box = boxRef.current;
    if (box && !box.contains(document.activeElement)) box.focus();
    return () => {
      releaseShortcuts();
      prev?.focus();
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    trapTab(e, boxRef.current);
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[160] flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={`${className} outline-none`}
      >
        {children}
      </div>
    </div>
  );
}
