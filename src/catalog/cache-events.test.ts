// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The announcement of a RAW cache entry rewritten with its decoded size and
// centre sample, which the Develop view listens for.

import { afterEach, describe, expect, it, vi } from "vitest";
import { emitCacheEntryFilled, onCacheEntryFilled, type FilledEntry } from "./cache-events";
import { rawPhoto } from "@/modules/library/raw-photo.test-support";

const entry = (): FilledEntry => ({
  photo: rawPhoto("DSC_0001.NEF"),
  fullWidth: 6,
  fullHeight: 4,
  cutSample: () => ({ data: new Uint16Array(4), width: 1, height: 1, x: 2, y: 1, sourceWidth: 6, sourceHeight: 4 }),
});

const offs: (() => void)[] = [];
const listen = (listener: (e: FilledEntry) => void) => {
  offs.push(onCacheEntryFilled(listener));
};

afterEach(() => {
  for (const off of offs.splice(0)) off();
  vi.restoreAllMocks();
});

describe("the filled-entry event", () => {
  it("calls each listener in the order it subscribed, with the entry", () => {
    const heard: string[] = [];
    const filled = entry();
    listen((e) => heard.push(`first ${e === filled}`));
    listen((e) => heard.push(`second ${e === filled}`));

    emitCacheEntryFilled(filled);

    expect(heard).toEqual(["first true", "second true"]);
  });

  it("stops calling a listener once it unsubscribes", () => {
    const heard: number[] = [];
    const off = onCacheEntryFilled(() => heard.push(1));
    off();

    emitCacheEntryFilled(entry());

    expect(heard).toEqual([]);
  });

  // A view that fails must never fail the cache work that announced the entry.
  it("logs a listener that throws and still calls the next", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const heard: string[] = [];
    listen(() => {
      throw new Error("view gone");
    });
    listen(() => heard.push("next"));

    expect(() => emitCacheEntryFilled(entry())).not.toThrow();

    expect(heard).toEqual(["next"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe("[cache] filled-entry listener failed:");
  });
});
