// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Backdrop dismissal for a modal card. A click fires on the nearest common
// ancestor of its press and release, so a text selection dragged out of a field
// and released over the backdrop "clicks" the backdrop. Only a press that also
// began on the backdrop dismisses.

import { useRef, type MouseEvent, type PointerEvent } from "react";

export function useBackdropDismiss(onDismiss: () => void) {
  const pressedOnBackdrop = useRef(false);
  return {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      pressedOnBackdrop.current = e.target === e.currentTarget;
    },
    onClick: (e: MouseEvent<HTMLElement>) => {
      const dismiss = pressedOnBackdrop.current && e.target === e.currentTarget;
      pressedOnBackdrop.current = false;
      if (dismiss) onDismiss();
    },
  };
}
