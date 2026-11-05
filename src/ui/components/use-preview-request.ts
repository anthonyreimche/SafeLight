// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useEffect, useRef } from "react";
import { requestThumbnail } from "@/state/thumbnail-loader";

/** Ref for a photo's cell or row: while `needsPreview`, asks the loader for the
 *  photo's grid preview as soon as the element nears the viewport, ahead of the idle
 *  prefill. A project's previews are read as they scroll into view, so a cell or row
 *  without one stays blank unless it asks. */
export function usePreviewRequest<T extends HTMLElement>(photoId: string, needsPreview: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!needsPreview) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          requestThumbnail(photoId, { visible: true });
          io.disconnect();
        }
      },
      { rootMargin: "300px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [needsPreview, photoId]);
  return ref;
}
