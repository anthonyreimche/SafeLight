// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Keeps a drag from selecting text. The browser starts a selection from the
// press itself, before any state a drag sets can render, so a pan that wanders
// over a panel selects its text; cancelling `selectstart` for the length of the
// drag stops that without making any text unselectable.

/** Hold off text selection in `doc` until the returned release is called. A
 *  second release does nothing. */
export function holdTextSelection(doc: Document = document): () => void {
  const block = (e: Event) => e.preventDefault();
  doc.addEventListener("selectstart", block, true);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    doc.removeEventListener("selectstart", block, true);
  };
}
