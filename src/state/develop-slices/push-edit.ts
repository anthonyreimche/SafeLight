// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { broadcast } from "../broadcast";
import type { DevelopState } from "../develop-store";

// Broadcast the current params so the renderer re-renders live during an edit.
// History is written separately by commitEdit at gesture end.
export function pushEdit(get: () => DevelopState): void {
  const s = get();
  broadcast({
    type: "edit-update",
    payload: { photoId: s.photoId, params: s.params },
  });
}
