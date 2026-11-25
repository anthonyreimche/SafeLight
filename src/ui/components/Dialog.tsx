// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Shell for the small single-purpose dialogues (rename, copy settings): a centred
// card over a dimmed backdrop that closes on a press outside the card. ModalWindow
// is the draggable, titled window; this is its lightweight sibling with the same
// modal contract — named by the caller's heading, focus moved in on open and
// handed back on close, Tab kept inside, Esc closes, Enter runs onSubmit.
//
// App shortcuts stand down while it is up. Their capture-phase listeners
// would otherwise rate, flag or remove the selection behind it, since a
// focused checkbox or button isn't a text field they defer to. Paused, they
// no longer drain the escape stack either, so Esc is handled here.

import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { useBackdropDismiss } from "./backdrop-dismiss";
import { suspendShortcuts } from "@/state/keybindings-store";
import { trapTab } from "@/ui/focus-trap";

interface DialogProps {
  /** Id of the visible heading that names the dialogue. */
  labelledBy: string;
  onClose: () => void;
  /** The dialogue's main action, run by Enter unless a button or a multi-line
   *  field has the key. */
  onSubmit?: () => void;
  /** Card classes (size, surface, border). */
  className: string;
  children: ReactNode;
}

export function Dialog({ labelledBy, onClose, onSubmit, className, children }: DialogProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const backdrop = useBackdropDismiss(onClose);

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
    } else if (e.key === "Enter" && onSubmit && !keepsEnter(e.target)) {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div
      className="sl-enter-dim fixed inset-0 z-[160] flex items-center justify-center bg-black/50"
      {...backdrop}
    >
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={`sl-enter-pop ${className} outline-none`}
      >
        {children}
      </div>
    </div>
  );
}

function keepsEnter(target: EventTarget): boolean {
  return (
    target instanceof HTMLButtonElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.getAttribute("role") === "button")
  );
}
