// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The render worker is created by the first getRenderBridge(), which a session that
// browses the Library first would make on its first Develop click: worker spawn and
// context creation (~150-400 ms) on top of the photo's own load. Once a project is
// open and the extensions have settled (their stages are posted ahead of init), the
// bridge starts while the app is idle instead.

import { useExternalPluginsSettled } from "@/extensions/loader";
import { useProjectStore } from "@/project/project-store";
import { readGpuBackend, useGraphics } from "@/state/graphics-store";
import { getRenderBridge } from "./render-bridge";

// Where there is no idle callback, or the page never idles, it starts anyway.
const IDLE_TIMEOUT_MS = 3_000;
const NO_IDLE_DELAY_MS = 1_000;

function whenIdle(run: () => void): () => void {
  if (typeof requestIdleCallback === "function") {
    const handle = requestIdleCallback(run, { timeout: IDLE_TIMEOUT_MS });
    return () => cancelIdleCallback(handle);
  }
  const handle = setTimeout(run, NO_IDLE_DELAY_MS);
  return () => clearTimeout(handle);
}

/** Starts the shared render bridge once a project is open and the extensions have
 *  settled, in an idle callback; never when this launch draws in software, whose
 *  worker is slow to start and worth not holding for a view that may not open.
 *  Returns the stop. */
export function startRenderBridgeWarmup(): () => void {
  let stopped = false;
  let scheduled = false;
  let cancelIdle: (() => void) | null = null;
  const unsubscribers: (() => void)[] = [];

  const stop = () => {
    stopped = true;
    cancelIdle?.();
    cancelIdle = null;
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  };

  const warm = async () => {
    if (useGraphics.getState().software === null) await readGpuBackend();
    const { software, webgl2 } = useGraphics.getState();
    if (stopped) return;
    stop();
    if (software === true || webgl2 === "no") return;
    getRenderBridge();
  };

  const check = () => {
    if (scheduled || stopped) return;
    if (useProjectStore.getState().root === null) return;
    if (!useExternalPluginsSettled.getState().settled) return;
    scheduled = true;
    cancelIdle = whenIdle(() => {
      warm().catch((err: unknown) => console.warn("[render-bridge] warm-up failed:", err));
    });
  };

  unsubscribers.push(useProjectStore.subscribe(check), useExternalPluginsSettled.subscribe(check));
  check();
  return stop;
}
