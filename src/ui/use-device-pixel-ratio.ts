// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useEffect, useState } from "react";

function readDpr(): number {
  return typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
}

/** The window's device pixel ratio, kept current when it changes without a resize
 *  (dragging the window to a monitor with another scale, browser zoom). There is
 *  no event for the ratio itself; a resolution query for the current value stops
 *  matching when it changes, so each change re-subscribes to the new value. */
export function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(readDpr);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const onChange = () => setDpr(readDpr());
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [dpr]);
  return dpr;
}
