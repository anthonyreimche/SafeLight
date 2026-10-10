// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Develop status-bar button that moves the open photo from the older processing
// to the current one, as one undoable step (develop-store's updateProcessing).
// It shows exactly when that action would act (usesOlderProcessing), so a photo
// already on the current processing never sees it. No confirmation: Undo puts
// the photo back.

import { usesOlderProcessing } from "@/catalog/types";
import { useDevelopStore } from "@/state/develop-store";

const TOOLTIP =
  "This photo uses the older processing, which clips bright, very saturated colours early. " +
  "Update it to keep them. Undo puts it back.";

export function ProcessingUpdateControl() {
  const photoId = useDevelopStore((s) => s.photoId);
  const older = useDevelopStore((s) => usesOlderProcessing(s.params));
  const updateProcessing = useDevelopStore((s) => s.updateProcessing);
  if (!photoId || !older) return null;
  return (
    <button
      onClick={() => void updateProcessing()}
      title={TOOLTIP}
      className="text-[10px] text-text-muted hover:text-text-primary"
    >
      Update processing
    </button>
  );
}
