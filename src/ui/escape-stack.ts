// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A LIFO stack of "Escape closes me" handlers for stacked modals. The most
// recently opened modal is closed first. Dialogs register while mounted; the
// global keyboard hook (use-keyboard-shortcuts) pops the top on Escape before
// falling back to exiting develop tool modes.

type EscHandler = () => void;

const stack: EscHandler[] = [];

/** Register a handler while a modal is open; returns an unregister fn. */
export function pushEscapeHandler(h: EscHandler): () => void {
  stack.push(h);
  return () => {
    const i = stack.lastIndexOf(h);
    if (i >= 0) stack.splice(i, 1);
  };
}

/** Invoke the top handler. Returns true if one was present (i.e. consumed). */
export function popEscapeHandler(): boolean {
  const h = stack[stack.length - 1];
  if (!h) return false;
  h();
  return true;
}
