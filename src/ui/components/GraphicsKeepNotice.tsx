// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The first launch on a graphics backend changed in Preferences asks, from its
// own window, to keep it, the way a display settings change does. A window that
// opens but draws nothing reports no error, and nobody can press Keep in it, so
// main goes back by itself when the time is up; this counts that time down.
// A change whose window can't start WebGL2 goes back at once: Chromium can
// report WebGL on while no context can be made (Vulkan on Mesa's software
// driver), so only the window's own probe, GraphicsNotice's, sees it.

import { useEffect, useState } from "react";
import { detachedModule } from "@/state/detach";
import {
  GRAPHICS_CHANGE_FAILED,
  backendLabel,
  failGraphicsChange,
  graphicsUnavailableDetail,
  keepGraphicsChange,
  readGpuBackend,
  undoGraphicsChange,
  useGraphics,
} from "@/state/graphics-store";

export function GraphicsKeepNotice() {
  const main = detachedModule() === null;
  const keep = useGraphics((s) => s.keep);
  const webgl2 = useGraphics((s) => s.webgl2);
  const reason = useGraphics((s) => s.reason);
  const [now, setNow] = useState(() => Date.now());
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (main) void readGpuBackend();
  }, [main]);

  useEffect(() => {
    if (!keep) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(tick);
  }, [keep]);

  const trying = keep !== null;
  useEffect(() => {
    if (!main || !trying || webgl2 !== "no") return;
    failGraphicsChange(graphicsUnavailableDetail(reason)).catch((err: unknown) => {
      console.warn("[safelight] couldn't report the graphics change as failed", err);
    });
  }, [main, trying, webgl2, reason]);

  if (!main || !keep) return null;

  const answer = (send: () => Promise<void>) => {
    setProblem(null);
    send().catch((err: unknown) => {
      console.warn("[safelight] couldn't change the graphics backend setting", err);
      setProblem(GRAPHICS_CHANGE_FAILED);
    });
  };
  const seconds = Math.max(0, Math.ceil((keep.by - now) / 1_000));

  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-4 mb-2 flex max-w-xl self-center items-start gap-3 rounded border border-border bg-surface-2 px-4 py-3 text-[11px] text-text-secondary shadow-lg"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="break-words text-text-primary">
          Safelight is now drawing with {backendLabel(keep.drawing)}. Keep this graphics setting? Safelight goes back to{" "}
          {backendLabel(keep.back)} in {seconds} s.
        </p>
        {problem && <p>{problem}</p>}
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => answer(keepGraphicsChange)}
            className="rounded border border-border px-2.5 py-1 text-[11px] text-text-primary hover:bg-surface-3"
          >
            Keep
          </button>
          <button
            onClick={() => answer(undoGraphicsChange)}
            className="rounded border border-border px-2.5 py-1 text-[11px] text-text-primary hover:bg-surface-3"
          >
            Go back
          </button>
        </div>
      </div>
    </div>
  );
}
