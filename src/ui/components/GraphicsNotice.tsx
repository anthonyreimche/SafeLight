// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The main window's word that this computer can't start the image engine, and
// what still works. Shown once per session: dismissed, it stays away until the
// next launch. Software rendering is offered only where Safelight picks the
// graphics backend itself, and only while the next launch would still use the
// graphics card.

import { useEffect, useState } from "react";
import { detachedModule } from "@/state/detach";
import {
  GRAPHICS_STILL_WORKS,
  GRAPHICS_UNAVAILABLE,
  RESTART_FAILED,
  dismissGraphicsNotice,
  graphicsUnavailableDetail,
  probeGraphics,
  readGpuBackend,
  restartSafelight,
  trySoftwareRendering,
  useGraphics,
} from "@/state/graphics-store";
import { openReportIssue } from "./report-issue-store";
import { DismissButton } from "./DismissButton";

export function GraphicsNotice() {
  const main = detachedModule() === null;
  const webgl2 = useGraphics((s) => s.webgl2);
  const reason = useGraphics((s) => s.reason);
  const software = useGraphics((s) => s.software);
  const nextSoftware = useGraphics((s) => s.nextSoftware);
  const dismissed = useGraphics((s) => s.noticeDismissed);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (main && probeGraphics().webgl2 === "no") void readGpuBackend();
  }, [main]);

  if (!main || webgl2 !== "no" || dismissed) return null;

  const restartNow = () => {
    setProblem(null);
    restartSafelight().catch((err: unknown) => {
      console.warn("[safelight] couldn't restart", err);
      setProblem(RESTART_FAILED);
    });
  };
  // Software turned on for the next launch, which this one doesn't use yet.
  const restartPending = nextSoftware === true && software === false;

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="sl-enter-rise mx-4 mb-2 flex max-w-xl self-center items-start gap-3 rounded border border-danger/40 bg-surface-2 px-4 py-3 text-[11px] text-text-secondary shadow-lg"
    >
      <span className="text-danger" aria-hidden="true">
        ⚠
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="break-words text-text-primary" title={graphicsUnavailableDetail(reason)}>
          {GRAPHICS_UNAVAILABLE} {GRAPHICS_STILL_WORKS}
        </p>
        {restartPending && <p>Software rendering takes effect when you restart Safelight.</p>}
        {problem && <p>{problem}</p>}
        <div className="flex flex-wrap gap-2">
          {nextSoftware === false && (
            <button
              onClick={() => void trySoftwareRendering()}
              className="rounded border border-border px-2.5 py-1 text-[11px] text-text-primary hover:bg-surface-3"
            >
              Try software rendering
            </button>
          )}
          {restartPending && (
            <button
              onClick={restartNow}
              className="rounded border border-border px-2.5 py-1 text-[11px] text-text-primary hover:bg-surface-3"
            >
              Restart Safelight
            </button>
          )}
          <button
            onClick={() => void openReportIssue({ title: "The image engine (WebGL2) can't start" })}
            className="rounded border border-border px-2.5 py-1 text-[11px] text-text-primary hover:bg-surface-3"
          >
            Report an issue
          </button>
        </div>
      </div>
      <DismissButton onClick={dismissGraphicsNotice} />
    </div>
  );
}
