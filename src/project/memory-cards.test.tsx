// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listed = { id: string; name: string; path: string };

const h = vi.hoisted(() => ({ fs: null as null | { listCards?: () => Promise<Listed[]> } }));
vi.mock("@/native/privileged", () => ({ privilegedFs: () => h.fs }));

import { nativePathOf } from "./native-fs";
import { CARD_POLL_MS, onMemoryCards, useMemoryCards } from "./memory-cards";

let answer: Listed[];
let listCards: ReturnType<typeof vi.fn<() => Promise<Listed[]>>>;

async function tick(ms = CARD_POLL_MS) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  answer = [];
  listCards = vi.fn(async () => answer);
  h.fs = { listCards };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useMemoryCards", () => {
  it("is empty and asks nothing in the browser build", async () => {
    h.fs = null;
    const { result } = renderHook(() => useMemoryCards());
    await tick();
    expect(result.current).toEqual([]);
  });

  it("lists the cards in the computer with a read-only folder for each", async () => {
    answer = [{ id: "a1", name: "E:", path: "E:\\" }];
    const { result, unmount } = renderHook(() => useMemoryCards());
    await tick(0);
    expect(result.current).toEqual([{ id: "a1", name: "E:", path: "E:\\", folder: expect.anything() }]);
    expect(nativePathOf(result.current[0].folder)).toBeNull();
    expect("removeEntry" in result.current[0].folder).toBe(false);
    unmount();
  });

  it("follows cards going in and out, keeping the same list while nothing changes", async () => {
    answer = [{ id: "a1", name: "E:", path: "E:\\" }];
    const { result, unmount } = renderHook(() => useMemoryCards());
    await tick(0);
    const first = result.current;
    await tick();
    expect(result.current).toBe(first);
    answer = [...answer, { id: "b2", name: "F:", path: "F:\\" }];
    await tick();
    expect(result.current.map((c) => c.id)).toEqual(["a1", "b2"]);
    expect(result.current[0]).toBe(first[0]);
    answer = [{ id: "b2", name: "F:", path: "F:\\" }];
    await tick();
    expect(result.current.map((c) => c.id)).toEqual(["b2"]);
    unmount();
  });

  it("shares one poll between users and stops when the last one goes", async () => {
    const one = renderHook(() => useMemoryCards());
    const two = renderHook(() => useMemoryCards());
    await tick(0);
    await tick();
    expect(listCards).toHaveBeenCalledTimes(2);
    one.unmount();
    await tick();
    expect(listCards).toHaveBeenCalledTimes(3);
    two.unmount();
    await tick();
    await tick();
    expect(listCards).toHaveBeenCalledTimes(3);
  });

  it("asks again when the window comes back to the front", async () => {
    const { unmount } = renderHook(() => useMemoryCards());
    await tick(0);
    const calls = listCards.mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(listCards.mock.calls.length).toBe(calls + 1);
    unmount();
  });

  it("keeps the last list when a poll fails", async () => {
    answer = [{ id: "a1", name: "E:", path: "E:\\" }];
    const { result, unmount } = renderHook(() => useMemoryCards());
    await tick(0);
    listCards.mockRejectedValueOnce(new Error("busy"));
    await tick();
    expect(result.current.map((c) => c.id)).toEqual(["a1"]);
    unmount();
  });
});

describe("onMemoryCards", () => {
  it("tells its listener what the first check found, then each time the cards change, and stops asking once unsubscribed", async () => {
    const seen: string[][] = [];
    const off = onMemoryCards((cards) => seen.push(cards.map((c) => c.id)));
    await tick(0);
    answer = [{ id: "a1", name: "E:", path: "E:\\" }];
    await tick();
    await tick();
    answer = [];
    await tick();
    expect(seen).toEqual([[], ["a1"], []]);
    off();
    off();
    const calls = listCards.mock.calls.length;
    await tick();
    expect(listCards.mock.calls.length).toBe(calls);
  });

  it("tells a listener that joins later what is in now", async () => {
    answer = [{ id: "a1", name: "E:", path: "E:\\" }];
    const offFirst = onMemoryCards(() => {});
    await tick(0);
    const seen: string[][] = [];
    const off = onMemoryCards((cards) => seen.push(cards.map((c) => c.id)));
    await tick(0);
    expect(seen).toEqual([["a1"]]);
    off();
    offFirst();
  });
});
