import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistogramData } from "@/rendering/histogram";
import { createHistogramScheduler } from "./histogram-scheduler";

const settings = vi.hoisted(() => ({ liveHistogram: true }));
vi.mock("@/state/settings-store", () => ({ getSettings: () => settings }));

function histogram(): HistogramData {
  const bins = () => new Uint32Array(256);
  return { r: bins(), g: bins(), b: bins(), luma: bins() };
}

describe("histogram scheduler", () => {
  const compute = vi.fn();
  const publish = vi.fn();
  const host = { renderQueued: () => false, compute, publish };

  beforeEach(() => {
    vi.useFakeTimers();
    compute.mockClear();
    publish.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it.each([true, false])("recomputes after a frame with none when live is %s", (live) => {
    settings.liveHistogram = live;
    const scheduler = createHistogramScheduler(host);
    scheduler.markDirty();
    scheduler.onFrame(undefined);
    vi.advanceTimersByTime(1000);
    expect(compute).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });

  it.each([true, false])("leaves a frame whose histogram follows alone when live is %s", (live) => {
    settings.liveHistogram = live;
    const scheduler = createHistogramScheduler(host);
    scheduler.markDirty();
    scheduler.onFrame(undefined, true);
    vi.advanceTimersByTime(1000);
    expect(compute).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    scheduler.dispose();
  });

  it("still publishes a histogram a frame carries", () => {
    const scheduler = createHistogramScheduler(host);
    const carried = histogram();
    scheduler.onFrame(carried, true);
    expect(publish).toHaveBeenCalledWith(carried);
    scheduler.dispose();
  });
});
