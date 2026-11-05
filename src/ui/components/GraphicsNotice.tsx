// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The main window's word that this computer can't start the image engine, and
// what still works. Shown once per session: dismissed, it stays away until the
// next launch. Software rendering is offered only where Safelight picks the
// graphics backend itself, and only while the next launch would still use the
// graphics card.

import { useEffect } from "react";
import { detachedModule } from "@/state/detach";
import {
  GRAPHICS_STILL_WORKS,
  GRAPHICS_UNAVAILABLE,
  dismissGraphicsNotice,
  graphicsUnavailableDetail,
  probeGraphics,
  readGpuBackend,
  trySoftwareRendering,
  useGraphics,
} from "@/state/graphics-store";
import { openReportIssue } from "./report-issue-store";

export function GraphicsNotice() {
  const main = detachedModule() === null;
  const webgl2 = useGraphics((s) => s.webgl2);
  const reason = useGraphics((s) => s.reason);
  const software = useGraphics((s) => s.software);
  const nextSoftware = useGraphics((s) => s.nextSoftware);
  const dismissed = useGraphics((s) => s.noticeDismissed);

  useEffect(() => {
    if (main && probeGraphics().webgl2 === "no") void readGpuBackend();
  }, [main]);

  if (!main || webgl2 !== "no" || dismissed) return null;

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="mx-4 mb-2 flex max-w-xl self-center items-start gap-3 rounded border border-danger/40 bg-surface-2 px-4 py-3 text-[11px] text-text-secondary shadow-lg"
    >
      <span className="text-danger" aria-hidden="true">
        ⚠
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="break-words text-text-primary" title={graphicsUnavailableDetail(reason)}>
          {GRAPHICS_UNAVAILABLE} {GRAPHICS_STILL_WORKS}
        </p>
        {nextSoftware === true && software === false && (
          <p>Software rendering takes effect when you restart Safelight.</p>
        )}
        <div className="flex flex-wrap gap-2">
          {nextSoftware === false && (
            <button
              onClick={() => void trySoftwareRendering()}
              className="rounded border border-border px-2.5 py-1 text-[11px] text-text-primary hover:bg-surface-3"
            >
              Try software rendering
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
      <button
        onClick={dismissGraphicsNotice}
        aria-label="Dismiss"
        className="shrink-0 rounded px-1.5 py-1 text-text-muted hover:text-text-primary"
      >
        ×
      </button>
    </div>
  );
}
