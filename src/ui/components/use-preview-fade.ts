// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useCallback, useEffect, useState } from "react";
import { hasPreviewLoaded, markPreviewLoaded } from "@/state/preview-urls";

interface Shown {
  photoId: string;
  /** The preview asked for. */
  url: string | null;
  /** The preview the <img> shows: the one before, while a new one of the same photo decodes. */
  src: string | null;
  loaded: boolean;
}

function settle(prev: Shown | null, url: string | null, photoId: string): Shown {
  const swap = prev !== null && prev.photoId === photoId && prev.loaded && prev.src !== null && url !== null;
  if (swap) return { photoId, url, src: prev.src, loaded: true };
  return { photoId, url, src: url, loaded: hasPreviewLoaded(url) };
}

/** Which preview a grid or list cell shows, and whether it has painted, for the fade-in.
 *  A preview the grid already showed comes back shown. A new preview of the same photo
 *  (a turn, a rebuilt preview, another window's replacement) is decoded off screen and
 *  swapped in whole, so the cell never blanks; the <img> keeps painting the old picture
 *  meanwhile even though its URL has been revoked. Another photo starts hidden and fades in. */
export function usePreviewFade(url: string | null, photoId: string) {
  const [shown, setShown] = useState<Shown>(() => settle(null, url, photoId));
  let current = shown;
  if (shown.url !== url || shown.photoId !== photoId) {
    current = settle(shown, url, photoId);
    setShown(current);
  }

  const { src } = current;
  useEffect(() => {
    if (url === null || src === url) return;
    let live = true;
    const show = () => {
      if (!live) return;
      markPreviewLoaded(url);
      setShown((s) => (s.url === url ? { ...s, src: url, loaded: true } : s));
    };
    const next = new Image();
    next.src = url;
    // A preview that can't be decoded is never swapped in: the cell keeps the picture
    // it has rather than going broken.
    if (typeof next.decode === "function") next.decode().then(show, () => {});
    else show();
    return () => {
      live = false;
    };
  }, [url, src]);

  const onLoad = useCallback(() => {
    if (src) markPreviewLoaded(src);
    setShown((s) => (s.src === src && !s.loaded ? { ...s, loaded: true } : s));
  }, [src]);

  return { src: current.src, loaded: current.loaded, onLoad };
}
