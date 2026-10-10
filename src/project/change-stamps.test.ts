// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { storedPhoto, type StoredPhoto } from "@/catalog/types";
import { photo } from "@/catalog/stored-edit.fixtures";
import {
  ChangeClock,
  changedGroups,
  mergePhoto,
  newer,
  readChangeStamps,
  type ChangeStamp,
} from "./change-stamps";

const record = (changes: Partial<StoredPhoto> = {}): StoredPhoto => ({
  ...storedPhoto(photo("x")),
  ...changes,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("newer", () => {
  it("never counts a missing stamp as newer, and counts any stamp newer than none", () => {
    expect(newer(undefined, [1, "a"])).toBe(false);
    expect(newer(undefined, undefined)).toBe(false);
    expect(newer([1, "a"], undefined)).toBe(true);
  });

  it("goes by the time, then by the storage, and an equal stamp is no newer", () => {
    expect(newer([2, "a"], [1, "b"])).toBe(true);
    expect(newer([1, "b"], [1, "a"])).toBe(true);
    expect(newer([1, "a"], [1, "b"])).toBe(false);
    expect(newer([1, "a"], [1, "a"])).toBe(false);
  });
});

describe("a change clock", () => {
  it("stamps later each time, within one millisecond too", () => {
    const clock = new ChangeClock("a");
    const first = clock.next();
    const second = clock.next();
    expect(first[0]).toBeGreaterThanOrEqual(Date.now());
    expect(newer(second, first)).toBe(true);
    expect(second[1]).toBe("a");
  });

  it("stamps after any stamp it has seen, even one ahead of the time", () => {
    const clock = new ChangeClock("a");
    const ahead: ChangeStamp = [Date.now() + 60_000, "z"];
    clock.observe(ahead);
    expect(newer(clock.next(), ahead)).toBe(true);
  });
});

describe("the groups a change touches", () => {
  it("names the one group a rating, flag, label or keyword change touches", () => {
    expect(changedGroups(record(), record({ rating: 3 }))).toEqual(["rating"]);
    expect(changedGroups(record(), record({ flag: "pick" }))).toEqual(["flag"]);
    expect(changedGroups(record(), record({ colorLabel: "red" }))).toEqual(["colorLabel"]);
    expect(changedGroups(record(), record({ keywords: ["sea"] }))).toEqual(["keywords"]);
  });

  it("puts a turn and the sizes it swaps in one group, and a move's fields in one", () => {
    const before = record({ width: 4000, height: 3000 });
    expect(changedGroups(before, { ...before, rotation: 90, width: 3000, height: 4000 })).toEqual([
      "shape",
    ]);
    expect(
      changedGroups(before, { ...before, filename: "b.jpg", relPath: "trip/b.jpg", folder: "trip" }),
    ).toEqual(["location"]);
  });

  it("leaves out the preview's description, and equal values in new objects", () => {
    const before = record({ keywords: ["sea"], exif: { iso: 100 } });
    const after = { ...before, keywords: ["sea"], exif: { iso: 100 }, previewEdit: "e1" };
    expect(changedGroups(before, { ...after, previewRotation: 90 })).toEqual([]);
    expect(changedGroups(record(), record({ decodeError: undefined }))).toEqual([]);
  });
});

describe("merging a record from another window", () => {
  it("takes each group the other window changed later, and keeps the rest", () => {
    const held = record({ rating: 2, flag: "pick" });
    const incoming = record({ rating: 5, flag: "none" });

    const merged = mergePhoto(held, { flag: [5, "b"] }, incoming, {
      rating: [4, "a"],
      flag: [3, "a"],
    });

    expect(merged.record).toMatchObject({ rating: 5, flag: "pick" });
    expect(merged.stamps).toEqual({ rating: [4, "a"], flag: [5, "b"] });
    expect(merged.taken).toBe(true);
  });

  it("takes nothing unstamped over what it holds, and a whole location or none", () => {
    const held = record({ filename: "a.jpg", relPath: "a.jpg", folder: "" });
    const moved = record({ filename: "a.jpg", relPath: "trip/a.jpg", folder: "trip" });
    expect(mergePhoto(held, undefined, record({ rating: 5 }), undefined).taken).toBe(false);

    const merged = mergePhoto(held, { location: [1, "a"] }, moved, { location: [2, "b"] });

    expect(merged.record).toMatchObject({ relPath: "trip/a.jpg", folder: "trip" });
  });
});

describe("stamps as a catalog keeps them", () => {
  it("keeps the stamps it can read and leaves out the rest", () => {
    const stamps = readChangeStamps({
      photos: { a: { rating: [5, "w"], flag: ["x", 1], nonsense: [1, "w"] }, b: "junk" },
      edits: { a: [6, "w"], b: [Number.NaN, "w"] },
    });
    expect(stamps).toEqual({ photos: { a: { rating: [5, "w"] } }, edits: { a: [6, "w"] } });
    expect(readChangeStamps("junk")).toEqual({ photos: {}, edits: {} });
  });
});
