// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useState } from "react";

/** Whether the open photo's full image is still on its way, for Develop's loading
 *  bar. A load's `loading` ends when it hands the image over, before its first frame
 *  is drawn, so this holds on to that frame. */
export interface FullPending {
  pending: boolean;
  /** A load of the photo starts. */
  begin: () => void;
  /** The load ended. `finalComing`: it handed over the full image, whose first frame
   *  is still to come. Otherwise it settled on a preview, can't show the photo, or
   *  failed, and nothing more is coming. */
  settle: (finalComing: boolean) => void;
  /** A frame of the full image was put on the canvas. */
  shownFinal: () => void;
}

export function useFullPending(): FullPending {
  const [pending, setPending] = useState(false);
  const [calls] = useState(() => {
    // Whether this load's full image has shown already: a load settling after its
    // first final frame has nothing more to wait for.
    let shown = false;
    return {
      begin: () => {
        shown = false;
        setPending(true);
      },
      settle: (finalComing: boolean) => setPending(finalComing && !shown),
      shownFinal: () => {
        if (shown) return;
        shown = true;
        setPending(false);
      },
    };
  });
  return { pending, ...calls };
}
