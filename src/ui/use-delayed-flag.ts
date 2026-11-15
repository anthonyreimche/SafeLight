// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useEffect, useState } from "react";
import { WAIT_INDICATOR_DELAY_MS } from "./motion";

/** True once `active` has stayed true for `ms`, false the moment it ends, so a wait
 *  indicator shows only for a wait that lasts and a quick one never flashes it. */
export function useDelayedFlag(active: boolean, ms: number = WAIT_INDICATOR_DELAY_MS): boolean {
  const [shown, setShown] = useState(active && ms <= 0);
  useEffect(() => {
    if (!active) {
      setShown(false);
      return;
    }
    if (ms <= 0) {
      setShown(true);
      return;
    }
    const timer = setTimeout(() => setShown(true), ms);
    return () => clearTimeout(timer);
  }, [active, ms]);
  return active && shown;
}
