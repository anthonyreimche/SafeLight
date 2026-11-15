// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Auto runs over several renders, so the photo can change under it. Its
// result belongs to the photo it started on and must never land on another.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDevelopStore } from "@/state/develop-store";
import { setCatalogStorage } from "@/catalog/storage";
import { installMemoryStorage, type MemoryEdits } from "@/catalog/stored-edit.fixtures";
import { whiteBalanceStepFromLinear } from "@/rendering/auto-adjust";
import type { HistogramData } from "@/rendering/histogram";
import { SETTLE_TIMEOUT_MS, autoAdjust, whiteBalanceFromSample } from "./use-auto-adjust";

class SilentChannel {
  postMessage(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

function histogramOf(luma: Uint32Array): HistogramData {
  return { r: luma.slice(), g: luma.slice(), b: luma.slice(), luma };
}

// Every pixel at display level 30: far darker than Auto Tone's mid-grey aim, so
// no single step converges and the run keeps waiting on fresh renders.
function darkHistogram(): HistogramData {
  const luma = new Uint32Array(256);
  luma[30] = 1000;
  return histogramOf(luma);
}

// Median at Auto Tone's aim, the 0.25th and 99.75th percentiles at its black and
// white points, nothing clipped: the step that measures it is the last.
function convergedHistogram(): HistogramData {
  const luma = new Uint32Array(256);
  luma[6] = 25;
  luma[115] = 9949;
  luma[250] = 26;
  return histogramOf(luma);
}

const s = () => useDevelopStore.getState();
const labels = () => s().history.map((h) => h.label);

const INITIAL = useDevelopStore.getState();

let storage: MemoryEdits;
let stopRendering: () => void = () => {};

/** Stands in for Develop's view: every edit is drawn `ms` later, with a new
 *  histogram of the dark photo. */
function renderEditsAfter(ms: number): void {
  stopRendering = useDevelopStore.subscribe((state, prev) => {
    if (state.params !== prev.params) setTimeout(() => s().setHistogram(darkHistogram()), ms);
  });
}

function settledFlag(run: Promise<void>): () => boolean {
  let settled = false;
  void run.then(() => (settled = true));
  return () => settled;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("BroadcastChannel", SilentChannel);
  useDevelopStore.setState(INITIAL, true);
  storage = installMemoryStorage();
});

afterEach(() => {
  stopRendering();
  stopRendering = () => {};
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setCatalogStorage(null);
});

// Each step is measured on the frame drawn with it. On a slow graphics card that
// frame takes seconds, and measuring the frame before it again repeats the same
// correction: Exposure ran away while the rest barely moved.
describe("Auto Tone on a slow render", () => {
  it("measures each step on its own render, however long it takes", async () => {
    await s().loadEdit("A", 5000);
    s().setHistogram(darkHistogram());

    const running = autoAdjust.tone();
    await vi.advanceTimersByTimeAsync(0);
    const firstStep = s().params.exposure;
    expect(firstStep).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(2000);
    expect(s().params.exposure).toBe(firstStep);

    s().setHistogram(convergedHistogram());
    await vi.advanceTimersByTimeAsync(0);
    await running;

    expect(s().params.exposure).toBe(firstStep);
    expect(labels()).toEqual(["Original", "Auto Tone"]);
  });

  it("ends at once when the photo is left right after a step, before its wait begins", async () => {
    await s().loadEdit("A", 5000);
    s().setHistogram(darkHistogram());

    const settled = settledFlag(autoAdjust.tone());
    useDevelopStore.setState({ photoId: null });
    await vi.advanceTimersByTimeAsync(100);

    expect(settled()).toBe(true);
  });

  it("ends at once when a step can't move anything", async () => {
    await s().loadEdit("A", 5000);
    s().setParam("exposure", 5);
    s().setParam("whites", 100);
    s().setParam("blacks", -100);
    s().setHistogram(darkHistogram());

    const settled = settledFlag(autoAdjust.tone());
    await vi.advanceTimersByTimeAsync(100);

    expect(settled()).toBe(true);
  });

  it("keeps the steps so far, without measuring the old frame again, when no render comes", async () => {
    await s().loadEdit("A", 5000);
    s().setHistogram(darkHistogram());

    const running = autoAdjust.tone();
    await vi.advanceTimersByTimeAsync(0);
    const firstStep = s().params.exposure;
    const settled = settledFlag(running);

    await vi.advanceTimersByTimeAsync(SETTLE_TIMEOUT_MS - 100);
    expect(settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(200);

    expect(settled()).toBe(true);
    expect(s().params.exposure).toBe(firstStep);
    expect(labels()).toEqual(["Original", "Auto Tone"]);
  });
});

describe("Auto after a photo switch", () => {
  it("commits nothing to the photo it ends on, or the one it started on", async () => {
    await s().loadEdit("A", 5000);
    s().setHistogram(darkHistogram());

    const running = autoAdjust.tone();
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
    renderEditsAfter(50);

    const running = whiteBalanceFromSample(sample);
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

    const running = whiteBalanceFromSample(sample);
    await s().loadEdit("B", 5000);
    arrive(WARM);
    await vi.advanceTimersByTimeAsync(5000);
    await running;

    expect(s().params).toEqual(before);
    expect(labels()).toEqual(["Original"]);
    expect(storage.written).toEqual([]);
  });

  it("takes its applied steps back off when a later sample fails", async () => {
    await s().loadEdit("A", 5000);
    s().setHistogram(darkHistogram());
    const { params, paramBag } = s();
    const commitEdit = vi.spyOn(s(), "commitEdit");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let reads = 0;
    const sample = vi.fn(async (): Promise<Rgb | null> => {
      if (reads++ === 0) return WARM;
      throw new Error("worker gone");
    });
    renderEditsAfter(50);

    const running = whiteBalanceFromSample(sample);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(running).resolves.toBeUndefined();

    expect(sample).toHaveBeenCalledTimes(2);
    expect(s().params).toEqual(params);
    expect(s().paramBag).toEqual(paramBag);
    expect(commitEdit).not.toHaveBeenCalled();
    expect(labels()).toEqual(["Original"]);
    expect(error).toHaveBeenCalled();

    const again = vi.fn(async () => null);
    await whiteBalanceFromSample(again);
    expect(again).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
