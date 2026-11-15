// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A wait indicator shows only once the wait has lasted, so a quick load never
// flashes a skeleton or a bar.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useDelayedFlag } from "./use-delayed-flag";

describe("useDelayedFlag", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("turns on only once active has lasted the delay", () => {
    const { result } = renderHook(() => useDelayedFlag(true, 300));
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(299));
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });

  it("defaults to 300 ms", () => {
    const { result } = renderHook(() => useDelayedFlag(true));
    act(() => vi.advanceTimersByTime(299));
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });

  it("drops at once when active ends, and a wait that ends early never shows", () => {
    const { result, rerender } = renderHook(({ on }) => useDelayedFlag(on, 300), {
      initialProps: { on: true },
    });
    act(() => vi.advanceTimersByTime(300));
    expect(result.current).toBe(true);
    rerender({ on: false });
    expect(result.current).toBe(false);
    rerender({ on: true });
    act(() => vi.advanceTimersByTime(200));
    rerender({ on: false });
    act(() => vi.advanceTimersByTime(500));
    expect(result.current).toBe(false);
  });

  it("a delay of 0 is on at once", () => {
    const { result } = renderHook(() => useDelayedFlag(true, 0));
    expect(result.current).toBe(true);
  });
});
