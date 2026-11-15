import { describe, expect, it } from "vitest";
import type { EditSnapshot, EditState } from "./types";
import { freshParams } from "./types";
import { appendStep, currentLook, historyRows, moveCursor } from "./edit-steps";

const snap = (label: string, exposure: number): EditSnapshot => ({
  timestamp: 1,
  label,
  params: { ...freshParams(5500), exposure },
  paramBag: {},
});
const state = (labels: string[], currentIndex: number): EditState => ({
  photoId: "p",
  stack: labels.map((l, i) => snap(l, i)),
  currentIndex,
});
const target = { photoId: "p", asShot: 5500 };
const look = (exposure: number) => ({ params: { ...freshParams(5500), exposure }, paramBag: {} });

describe("currentLook", () => {
  it("is the fresh look at the as-shot temperature for a never-edited photo", () => {
    expect(currentLook(undefined, 4800).params.temperature).toBe(4800);
    expect(currentLook({ photoId: "p", stack: [], currentIndex: 0 }, 4800).paramBag).toEqual({});
  });

  it("is the step under the cursor", () => {
    expect(currentLook(state(["a", "b", "c"], 1), 5500).params.exposure).toBe(1);
  });

  it("falls back to the newest step for an unusable cursor", () => {
    expect(currentLook(state(["a", "b", "c"], Number.NaN), 5500).params.exposure).toBe(2);
  });
});

describe("appendStep", () => {
  it("seeds Original and the step for a never-edited photo", () => {
    const next = appendStep(undefined, target, "Exposure", look(1), 99);
    expect(next.stack.map((s) => s.label)).toEqual(["Original", "Exposure"]);
    expect(next.stack[0].params).toEqual(freshParams(5500));
    expect(next.stack[1].timestamp).toBe(99);
    expect(next.currentIndex).toBe(1);
    expect(next.photoId).toBe("p");
  });

  it("drops the steps ahead of the cursor", () => {
    const next = appendStep(state(["a", "b", "c"], 0), target, "new", look(7), 5);
    expect(next.stack.map((s) => s.label)).toEqual(["a", "new"]);
    expect(next.currentIndex).toBe(1);
  });

  it("appends at the end when the cursor is on the newest step", () => {
    const next = appendStep(state(["a", "b"], 1), target, "c", look(2), 5);
    expect(next.stack.map((s) => s.label)).toEqual(["a", "b", "c"]);
  });
});

describe("moveCursor", () => {
  it("moves by the given steps and clamps at both ends", () => {
    const s = state(["a", "b", "c"], 2);
    expect(moveCursor(s, -1).currentIndex).toBe(1);
    expect(moveCursor(s, -9).currentIndex).toBe(0);
    expect(moveCursor(state(["a", "b", "c"], 0), 9).currentIndex).toBe(2);
  });

  it("returns the same object when nothing moves", () => {
    const s = state(["a", "b"], 1);
    expect(moveCursor(s, 1)).toBe(s);
    expect(moveCursor(s, 0)).toBe(s);
  });
});

describe("historyRows", () => {
  it("marks the cursor's step and is empty with no edit", () => {
    expect(historyRows(undefined)).toEqual([]);
    const rows = historyRows(state(["a", "b"], 0));
    expect(rows.map((r) => r.current)).toEqual([true, false]);
    expect(rows[1]).toMatchObject({ index: 1, label: "b" });
  });
});
