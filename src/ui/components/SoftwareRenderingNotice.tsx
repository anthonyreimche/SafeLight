// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Safelight moves itself to software rendering when the graphics card fails,
// and stays there for several launches. Without a word in the window that only
// shows as a slow editor, so this says so, why, and how to try the graphics card
// again. Software the user picked in Preferences needs no notice.

import { useEffect, useState } from "react";
import { detachedModule } from "@/state/detach";
import {
  GRAPHICS_CHANGE_FAILED,
  RESTART_FAILED,
  SOFTWARE_REASON,
  chooseGraphicsBackend,
  dismissSoftwareNotice,
  readGpuBackend,
  restartSafelight,
  useGraphics,
} from "@/state/graphics-store";
import { openReportIssue } from "./report-issue-store";

const SLOWER = "Editing is much slower than on the graphics card.";

export function SoftwareRenderingNotice() {
  const main = detachedModule() === null;
  const webgl2 = useGraphics((s) => s.webgl2);
  const software = useGraphics((s) => s.software);
  const reason = useGraphics((s) => s.softwareReason);
  const dismissed = useGraphics((s) => s.softwareNoticeDismissed);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (main) void readGpuBackend();
  }, [main]);

  // A missing WebGL2 has its own notice, which says what still works.
  if (!main || software !== true || reason === "chosen" || webgl2 === "no" || dismissed) return null;

  const tryGraphicsCard = () => {
    setProblem(null);
    chooseGraphicsBackend(null).catch((err: unknown) => {
      console.warn("[safelight] couldn't change the graphics backend setting", err);
      setProblem(GRAPHICS_CHANGE_FAILED);
    });
  };

  const restartNow = () => {
    setProblem(null);
    restartSafelight().catch((err: unknown) => {
      console.warn("[safelight] couldn't restart", err);
      setProblem(RESTART_FAILED);
    });
  };

  // `reason` is null once the next launch goes back to the graphics card.
  const text =
    reason === null
      ? `Safelight is drawing in software. ${SLOWER} It tries the graphics card again when you restart Safelight.`
      : `${SOFTWARE_REASON[reason]} ${SLOWER}`;

  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-4 mb-2 flex max-w-xl self-center items-start gap-3 rounded border border-border bg-surface-2 px-4 py-3 text-[11px] text-text-secondary shadow-lg"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="break-words text-text-primary">{text}</p>
        {problem && <p>{problem}</p>}
        <div className="flex flex-wrap gap-2">
          {reason !== null && (
            <button
              onClick={tryGraphicsCard}
              className="rounded border border-border px-2.5 py-1 text-[11px] text-text-primary hover:bg-surface-3"
            >
              Try the graphics card again
            </button>
          )}
          {reason === null && (
            <button
              onClick={restartNow}
              className="rounded border border-border px-2.5 py-1 text-[11px] text-text-primary hover:bg-surface-3"
            >
              Restart Safelight
            </button>
          )}
          <button
            onClick={() => void openReportIssue({ title: "Safelight switched to software rendering" })}
            className="rounded border border-border px-2.5 py-1 text-[11px] text-text-primary hover:bg-surface-3"
          >
            Report an issue
          </button>
        </div>
      </div>
      <button
        onClick={dismissSoftwareNotice}
        aria-label="Dismiss"
        className="shrink-0 rounded px-1.5 py-1 text-text-muted hover:text-text-primary"
      >
        ×
      </button>
    </div>
  );
}
