// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A graphics backend changed in Preferences that didn't work, or wasn't kept
// in time, sends the next launch back to the selection that last did. That
// happens with no dialogue, so without a word the user would think their pick
// is in use. This says which change went back, why, and to what, for the
// launch that went back.

import { useEffect } from "react";
import { detachedModule } from "@/state/detach";
import {
  backendLabel,
  dismissRevertNotice,
  readGpuBackend,
  revertSentence,
  useGraphics,
} from "@/state/graphics-store";
import { openReportIssue } from "./report-issue-store";

export function GraphicsRevertNotice() {
  const main = detachedModule() === null;
  const revert = useGraphics((s) => s.revert);
  const dismissed = useGraphics((s) => s.revertNoticeDismissed);

  useEffect(() => {
    if (main) void readGpuBackend();
  }, [main]);

  if (!main || !revert || dismissed) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-4 mb-2 flex max-w-xl self-center items-start gap-3 rounded border border-border bg-surface-2 px-4 py-3 text-[11px] text-text-secondary shadow-lg"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="break-words text-text-primary">{revertSentence(revert.from, revert.to, revert.because)}</p>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => void openReportIssue({ title: `Graphics backend ${backendLabel(revert.from)} didn't work` })}
            className="rounded border border-border px-2.5 py-1 text-[11px] text-text-primary hover:bg-surface-3"
          >
            Report an issue
          </button>
        </div>
      </div>
      <button
        onClick={dismissRevertNotice}
        aria-label="Dismiss"
        className="shrink-0 rounded px-1.5 py-1 text-text-muted hover:text-text-primary"
      >
        ×
      </button>
    </div>
  );
}
