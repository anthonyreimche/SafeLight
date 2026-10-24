// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Auto runs over several renders, so the photo can change under it. Its
// result belongs to the photo it started on and must never land on another.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useDevelopStore } from "@/state/develop-store";
import { setCatalogStorage } from "@/catalog/storage";
import { installMemoryStorage, type MemoryEdits } from "@/catalog/stored-edit.fixtures";
import { whiteBalanceStepFromLinear } from "@/rendering/auto-adjust";
import type { HistogramData } from "@/rendering/histogram";
import { useAutoAdjust } from "./use-auto-adjust";

class SilentChannel {
  postMessage(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

// Every pixel at display level 30: far darker than Auto Tone's mid-grey aim, so
// no single step converges and the run keeps waiting on fresh renders.
function darkHistogram(): HistogramData {
  const luma = new Uint32Array(256);
  luma[30] = 1000;
  return { r: luma.slice(), g: luma.slice(), b: luma.slice(), luma };
}

const s = () => useDevelopStore.getState();
const labels = () => s().history.map((h) => h.label);

const INITIAL = useDevelopStore.getState();

let storage: MemoryEdits;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("BroadcastChannel", SilentChannel);
  useDevelopStore.setState(INITIAL, true);
  storage = installMemoryStorage();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setCatalogStorage(null);
});

describe("Auto after a photo switch", () => {
  it("commits nothing to the photo it ends on, or the one it started on", async () => {
    await s().loadEdit("A", 5000);
    s().setHistogram(darkHistogram());
    const { result } = renderHook(() => useAutoAdjust());

    const running = result.current.autoTone();
    await s().loadEdit("B", 5000);
    await vi.advanceTimersByTimeAsync(5000);
    await running;

    expect(labels()).toEqual(["Original"]);
    expect(storage.written).toEqual([]);
    await s().loadEdit("A", 5000);
    expect(labels()).toEqual(["Original"]);
  });
});

type Rgb = [number, number, number];
const WARM: Rgb = [0.8, 0.5, 0.3];

// The eyedropper reads its sample from the render worker, so each read is a round
// trip the run has to wait out before it can apply the step.
describe("White-balance eyedropper", () => {
  it("waits for each sample, applies its step, and commits once", async () => {
    await s().loadEdit("A", 5000);
    s().setHistogram(darkHistogram());
    const want = whiteBalanceStepFromLinear(...WARM, s().params, s().asShotTemperature);
    const replies: (Rgb | null)[] = [WARM, null];
    const sample = vi.fn(async () => replies.shift() ?? null);
    const { result } = renderHook(() => useAutoAdjust());

    const running = result.current.whiteBalanceFromSample(sample);
    await vi.advanceTimersByTimeAsync(5000);
    await running;

    expect(sample).toHaveBeenCalledTimes(2);
    expect(s().params.temperature).toBe(want.temperature);
    expect(s().params.tint).toBe(want.tint);
    expect(labels()).toEqual(["Original", "White Balance"]);
  });

  it("drops a sample that arrives once another photo is open", async () => {
    await s().loadEdit("A", 5000);
    s().setHistogram(darkHistogram());
    const before = s().params;
    let arrive: (rgb: Rgb) => void = () => {};
    const sample = () => new Promise<Rgb | null>((resolve) => (arrive = resolve));
    const { result } = renderHook(() => useAutoAdjust());

    const running = result.current.whiteBalanceFromSample(sample);
    await s().loadEdit("B", 5000);
    arrive(WARM);
    await vi.advanceTimersByTimeAsync(5000);
    await running;

    expect(s().params).toEqual(before);
    expect(labels()).toEqual(["Original"]);
    expect(storage.written).toEqual([]);
  });
});
