// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Develop's loading bar: shown once the full image of the open photo has been on its
// way for WAIT_INDICATOR_DELAY_MS, and gone the moment its first frame shows, or the
// load ends without one to come (it settled on a preview, can't show the photo, or
// failed). A photo whose full image comes quickly never shows it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { WAIT_INDICATOR_DELAY_MS } from "@/ui/motion";
import { useDelayedFlag } from "@/ui/use-delayed-flag";
import { useFullPending } from "./use-full-pending";

function setup() {
  return renderHook(() => {
    const wait = useFullPending();
    return { wait, bar: useDelayedFlag(wait.pending) };
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useFullPending with the delayed bar", () => {
  it("is not pending before a load starts", () => {
    const view = setup();
    expect(view.result.current.wait.pending).toBe(false);
    expect(view.result.current.bar).toBe(false);
  });

  it("shows the bar once a load has waited for its full image, until its first frame", () => {
    const view = setup();
    act(() => view.result.current.wait.begin());
    expect(view.result.current.wait.pending).toBe(true);
    act(() => vi.advanceTimersByTime(WAIT_INDICATOR_DELAY_MS - 1));
    expect(view.result.current.bar).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(view.result.current.bar).toBe(true);

    // The load hands over the full image; its frame is still to come.
    act(() => view.result.current.wait.settle(true));
    expect(view.result.current.bar).toBe(true);

    act(() => view.result.current.wait.shownFinal());
    expect(view.result.current.wait.pending).toBe(false);
    expect(view.result.current.bar).toBe(false);
  });

  it("never shows the bar for a full image that comes quickly", () => {
    const view = setup();
    act(() => view.result.current.wait.begin());
    act(() => vi.advanceTimersByTime(100));
    act(() => view.result.current.wait.settle(true));
    act(() => view.result.current.wait.shownFinal());
    act(() => vi.advanceTimersByTime(1000));
    expect(view.result.current.bar).toBe(false);
  });

  it.each([
    ["settles on a preview"],
    ["can't show the photo"],
    ["fails"],
  ])("ends when the load %s", () => {
    const view = setup();
    act(() => view.result.current.wait.begin());
    act(() => vi.advanceTimersByTime(WAIT_INDICATOR_DELAY_MS));
    expect(view.result.current.bar).toBe(true);

    act(() => view.result.current.wait.settle(false));
    expect(view.result.current.wait.pending).toBe(false);
    expect(view.result.current.bar).toBe(false);
  });

  it("ends at a final frame shown before the load settles", () => {
    const view = setup();
    act(() => view.result.current.wait.begin());
    act(() => view.result.current.wait.shownFinal());
    act(() => view.result.current.wait.settle(true));
    expect(view.result.current.wait.pending).toBe(false);
  });

  it("waits again when the next load starts", () => {
    const view = setup();
    act(() => view.result.current.wait.begin());
    act(() => view.result.current.wait.settle(true));
    act(() => view.result.current.wait.shownFinal());

    act(() => view.result.current.wait.begin());
    expect(view.result.current.wait.pending).toBe(true);
    act(() => vi.advanceTimersByTime(WAIT_INDICATOR_DELAY_MS));
    expect(view.result.current.bar).toBe(true);
  });
});
