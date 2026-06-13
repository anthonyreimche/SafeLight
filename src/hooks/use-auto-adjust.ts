import { useCallback, useRef } from "react";
import { useDevelopStore } from "@/state/develop-store";
import {
  autoToneStep,
  autoWhiteBalanceStep,
  whiteBalanceStepFromLinear,
} from "@/rendering/auto-adjust";

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

export function useAutoAdjust() {
  // Guard against overlapping runs from rapid double-clicks.
  const running = useRef(false);

  const run = useCallback(
    async (
      apply: () => boolean, // applies one step, returns true when converged
      label: string,
    ) => {
      if (running.current) return;
      running.current = true;
      try {
        for (let i = 0; i < MAX_ITERS; i++) {
          if (!useDevelopStore.getState().histogram) break;
          const done = apply();
          if (done) break;
          await settle();
        }
        await useDevelopStore.getState().commitEdit(label);
      } finally {
        running.current = false;
      }
    },
    [],
  );

  const autoWhiteBalance = useCallback(
    () =>
      run(() => {
        const s = useDevelopStore.getState();
        const step = autoWhiteBalanceStep(s.histogram!, s.params);
        s.setParam("temperature", step.temperature);
        s.setParam("tint", step.tint);
        return step.done;
      }, "Auto White Balance"),
    [run],
  );

  // White-balance eyedropper. `sample` reads the linear RGB at the picked point
  // from the freshly rendered canvas; each iteration drives Temp/Tint to make
  // that point neutral, re-renders, and re-samples — same settle loop as Auto WB,
  // so the tone curve's non-linearity converges instead of being inverted once.
  const whiteBalanceFromSample = useCallback(
    (sample: () => [number, number, number] | null) =>
      run(() => {
        const s = useDevelopStore.getState();
        const rgb = sample();
        if (!rgb) return true;
        const step = whiteBalanceStepFromLinear(rgb[0], rgb[1], rgb[2], s.params);
        s.setParam("temperature", step.temperature);
        s.setParam("tint", step.tint);
        return step.done;
      }, "White Balance"),
    [run],
  );

  const autoTone = useCallback(
    () =>
      run(() => {
        const s = useDevelopStore.getState();
        const step = autoToneStep(s.histogram!, s.params);
        s.setParam("exposure", step.exposure);
        s.setParam("contrast", step.contrast);
        s.setParam("highlights", step.highlights);
        s.setParam("shadows", step.shadows);
        s.setParam("whites", step.whites);
        s.setParam("blacks", step.blacks);
        return step.done;
      }, "Auto Tone"),
    [run],
  );

  return { autoWhiteBalance, whiteBalanceFromSample, autoTone };
}
