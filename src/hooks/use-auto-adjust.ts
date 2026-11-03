// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { beforePhotoLeave, useDevelopStore } from "@/state/develop-store";
import {
  autoToneStep,
  autoWhiteBalanceStep,
  whiteBalanceStepFromLinear,
} from "@/rendering/auto-adjust";
import { probeCanvas } from "@/modules/develop/canvas-probe";
import type { CanvasPoint } from "@/modules/develop/pick-drag";

// One press of an Auto button drives the real render pipeline to convergence:
// apply a step → let the renderer re-render and recompute the histogram →
// re-measure → repeat, until the step reports `done` (or a safety cap). This is
// what made manual clicking converge after a few tries; here it happens
// automatically inside a single click, and only one history entry is written.

const MAX_ITERS = 8;
const SETTLE_TIMEOUT_MS = 450; // fallback if the histogram debounce is slow

// Resolve once the next render has produced a fresh histogram.
function settle(): Promise<void> {
  return new Promise((resolve) => {
    const prev = useDevelopStore.getState().histogram;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      unsub();
      clearTimeout(timer);
      resolve();
    };
    const unsub = useDevelopStore.subscribe((s) => {
      if (s.histogram !== prev) finish();
    });
    const timer = setTimeout(finish, SETTLE_TIMEOUT_MS);
  });
}

// One run at a time, whoever starts it (a double-click, a panel and an
// extension): a second press while one runs does nothing.
let running = false;

async function run(
  apply: () => boolean | Promise<boolean>, // applies one step, returns true when converged
  label: string,
): Promise<void> {
  if (running) return;
  running = true;
  const { photoId, params, paramBag } = useDevelopStore.getState();
  // A run cut short by a photo switch is no edit: its steps come off before
  // Develop commits what is left on the photo it leaves.
  const stopGuard = beforePhotoLeave(() => useDevelopStore.setState({ params, paramBag }));
  try {
    for (let i = 0; i < MAX_ITERS; i++) {
      if (!useDevelopStore.getState().histogram) break;
      const done = await apply();
      if (!done) await settle();
      // Another photo opened mid-run; committing would add this run's step
      // to that photo's history.
      if (useDevelopStore.getState().photoId !== photoId) return;
      if (done) break;
    }
    await useDevelopStore.getState().commitEdit(label);
  } finally {
    stopGuard();
    running = false;
  }
}

/** Grey-world white balance from the frame's histogram. */
function whiteBalance(): Promise<void> {
  return run(() => {
    const s = useDevelopStore.getState();
    const step = autoWhiteBalanceStep(s.histogram!, s.params, s.asShotTemperature);
    s.setParam("temperature", step.temperature);
    s.setParam("tint", step.tint);
    return step.done;
  }, "Auto White Balance");
}

/** The white-balance eyedropper. `sample` reads the linear RGB at the picked
 *  point from the render worker's live frame; each step drives Temp and Tint to
 *  make that point neutral, re-renders and samples again, so the tone curve's
 *  non-linearity converges instead of being inverted once. */
export function whiteBalanceFromSample(sample: () => Promise<readonly [number, number, number] | null>): Promise<void> {
  return run(async () => {
    const { photoId } = useDevelopStore.getState();
    const rgb = await sample();
    // The photo changed while the worker answered; `run` sees it and stops.
    const s = useDevelopStore.getState();
    if (!rgb || s.photoId !== photoId) return true;
    const step = whiteBalanceStepFromLinear(rgb[0], rgb[1], rgb[2], s.params, s.asShotTemperature);
    s.setParam("temperature", step.temperature);
    s.setParam("tint", step.tint);
    return step.done;
  }, "White Balance");
}

/** Auto Tone from the frame's histogram. */
function tone(): Promise<void> {
  return run(() => {
    const s = useDevelopStore.getState();
    const step = autoToneStep(s.histogram!, s.params);
    s.setParam("exposure", step.exposure);
    s.setParam("contrast", step.contrast);
    s.setParam("highlights", step.highlights);
    s.setParam("shadows", step.shadows);
    s.setParam("whites", step.whites);
    s.setParam("blacks", step.blacks);
    return step.done;
  }, "Auto Tone");
}

/** The Auto buttons' runs and the eyedropper's, as one undo step each. Each
 *  needs a frame's histogram and does nothing without one. `whiteBalanceAt`
 *  makes the colour at a point on the develop canvas neutral (canvas-probe.ts). */
export const autoAdjust = {
  whiteBalance,
  whiteBalanceAt: (point: CanvasPoint): Promise<void> => whiteBalanceFromSample(() => probeCanvas(point)),
  tone,
};
