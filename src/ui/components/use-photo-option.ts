// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useEffect, type KeyboardEvent, type RefObject } from "react";

/** Keyboard and screen-reader semantics for a photo cell or row. The active photo
 *  is the grid's one tab stop; Enter opens it. Arrow keys stay with the global
 *  shortcuts, which move the active photo, so a cell that becomes active takes DOM
 *  focus when an option in its own listbox held it — focus never jumps in from
 *  outside, nor across to another surface (grid and filmstrip) showing the photo. */
export function usePhotoOption(
  ref: RefObject<HTMLElement | null>,
  photoId: string,
  selected: boolean,
  active: boolean,
  onOpen: ((id: string) => void) | undefined,
) {
  useEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    const holder = document.activeElement;
    const heldHere =
      holder?.closest('[role="option"]') && holder.closest('[role="listbox"]') === el.closest('[role="listbox"]');
    if (holder && holder !== el && heldHere) {
      el.focus({ preventScroll: true });
    }
  }, [active, ref]);

  return {
    role: "option",
    "aria-selected": selected,
    tabIndex: active ? 0 : -1,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !onOpen) return;
      e.preventDefault();
      e.stopPropagation();
      onOpen(photoId);
    },
  } as const;
}
