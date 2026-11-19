// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What the live develop view last drew, as api.devtools.render.live reads it: the
// store the bridge writes for the live view alone, and how often.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearLiveOverflowed,
  noteLiveFrame,
  noteProgramStatus,
  noteRenderError,
  resetLiveStatus,
  setLiveViewSource,
  useLiveStatus,
} from "./live-status";

const live = () => useLiveStatus.getState().live;

let photoId: string | null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  photoId = "photo-1";
  resetLiveStatus();
  setLiveViewSource({ photoId: () => photoId, processVersion: () => 3 });
});

afterEach(() => {
  setLiveViewSource(null);
  vi.useRealTimers();
});

describe("the live render status", () => {
  it("is null until the live view draws a frame", () => {
    expect(live()).toBeNull();
  });

  it("takes a frame with what the view is drawing and the program it was told of", () => {
    noteProgramStatus({ programStages: ["a", "b@0"], dormant: ["c"] });
    noteLiveFrame({ overflowed: ["a"], frameMs: 12 });
    expect(live()).toEqual({
      at: 10_000,
      photoId: "photo-1",
      processVersion: 3,
      programStages: ["a", "b@0"],
      dormant: ["c"],
      overflowed: ["a"],
      frameMs: 12,
      lastError: null,
    });
  });

  it("writes nothing while no live view is registered", () => {
    setLiveViewSource(null);
    noteProgramStatus({ programStages: ["a"], dormant: [] });
    noteLiveFrame({ overflowed: [], frameMs: 5 });
    noteRenderError("boom");
    expect(live()).toBeNull();
  });

  it("applies a program status that arrives after the first frame at once", () => {
    noteLiveFrame({ overflowed: [], frameMs: 5 });
    noteProgramStatus({ programStages: ["a"], dormant: [] });
    expect(live()?.programStages).toEqual(["a"]);
  });

  describe("throttling", () => {
    it("writes a frame that changed only its time and frame time at most once a second", () => {
      noteLiveFrame({ overflowed: [], frameMs: 5 });
      vi.setSystemTime(10_400);
      noteLiveFrame({ overflowed: [], frameMs: 6 });
      expect(live()).toMatchObject({ at: 10_000, frameMs: 5 });
      vi.setSystemTime(11_000);
      noteLiveFrame({ overflowed: [], frameMs: 7 });
      expect(live()).toMatchObject({ at: 11_000, frameMs: 7 });
    });

    it("tells subscribers once for the frames it left out", () => {
      noteLiveFrame({ overflowed: [], frameMs: 5 });
      const listener = vi.fn();
      const off = useLiveStatus.subscribe(listener);
      vi.setSystemTime(10_100);
      noteLiveFrame({ overflowed: [], frameMs: 6 });
      noteLiveFrame({ overflowed: [], frameMs: 7 });
      expect(listener).not.toHaveBeenCalled();
      off();
    });

    it.each([
      ["the overflowed stages", () => noteLiveFrame({ overflowed: ["x"], frameMs: 5 })],
      ["the program", () => noteProgramStatus({ programStages: ["x"], dormant: [] })],
      ["the dormant stages", () => noteProgramStatus({ programStages: [], dormant: ["x"] })],
      ["the photo", () => ((photoId = "photo-2"), noteLiveFrame({ overflowed: [], frameMs: 5 }))],
      ["an error", () => noteRenderError("boom")],
    ])("writes at once when %s changed", (_name, change) => {
      noteLiveFrame({ overflowed: [], frameMs: 5 });
      const before = live();
      vi.setSystemTime(10_050);
      change();
      expect(live()).not.toBe(before);
    });
  });

  describe("render errors", () => {
    it("holds the last error until a later frame succeeds", () => {
      noteLiveFrame({ overflowed: [], frameMs: 5 });
      vi.setSystemTime(10_200);
      noteRenderError("shader threw");
      expect(live()?.lastError).toEqual({ at: 10_200, message: "shader threw" });
      vi.setSystemTime(10_300);
      noteLiveFrame({ overflowed: [], frameMs: 5 });
      expect(live()?.lastError).toBeNull();
      expect(live()?.at).toBe(10_300);
    });

    it("records an error before any frame has drawn", () => {
      noteRenderError("first frame threw");
      expect(live()).toMatchObject({
        lastError: { at: 10_000, message: "first frame threw" },
        frameMs: null,
        overflowed: [],
      });
    });
  });

  it("empties the overflowed stages when the view moves to another photo", () => {
    noteLiveFrame({ overflowed: ["x"], frameMs: 5 });
    clearLiveOverflowed();
    expect(live()?.overflowed).toEqual([]);
  });
});
