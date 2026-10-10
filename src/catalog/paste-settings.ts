// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Paste copied develop settings onto Library photos without opening Develop:
// merge the clipboard's partial params/bag over each photo's current look and
// append the result as one history snapshot (see stored-edit).

import { normalizeParams, withoutProcessVersion } from "./types";
import { appendStoredSnapshots, storedSnapshotTargets } from "./stored-edit";
import { normalizeParamBag } from "@/extensions/param-registry";
import type { DevelopClipboard } from "@/state/develop-clipboard";

const PASTE_LABEL = "Paste Settings";

/** Apply the clipboard's settings to every given photo, stored with one catalog
 *  write. Returns how many photos were updated. */
export async function pasteSettings(
  ids: string[],
  clip: DevelopClipboard,
): Promise<number> {
  return appendStoredSnapshots(storedSnapshotTargets(ids), PASTE_LABEL, (base) => ({
    params: normalizeParams({ ...base.params, ...withoutProcessVersion(clip.params) }),
    paramBag: { ...base.paramBag, ...normalizeParamBag(clip.paramBag) },
  }));
}
