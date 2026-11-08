// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Chromium starts a native drag from any image, link or text selection. One that
// starts under a pointer tool (a crop handle, a pan, a mask brush) fires
// pointercancel, so the tool stops after its first move and the cursor shows
// "no drop". Only elements the app marks draggable, and text inside editable
// fields, may start one.

const EDITABLE = 'input, textarea, [contenteditable=""], [contenteditable="true"]';

function allowsNativeDrag(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  return !!el?.closest(`[draggable="true"], ${EDITABLE}`);
}

export function installNativeDragGuard(doc: Document): () => void {
  const onDragStart = (e: Event) => {
    if (!allowsNativeDrag(e.target)) e.preventDefault();
  };
  doc.addEventListener("dragstart", onDragStart, true);
  return () => doc.removeEventListener("dragstart", onDragStart, true);
}
