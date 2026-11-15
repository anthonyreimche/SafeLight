// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// An edit history is stored the way git packs objects: a whole step every
// BASE_EVERY steps, and between them each step as the changes from the one
// before. Unpacked, every step is whole again, exactly as it was packed.

import { describe, expect, it } from "vitest";
import { BASE_EVERY, packStack, unpackStack } from "./history-pack";

type Step = { timestamp: number; label: string; params?: Record<string, unknown>; paramBag?: Record<string, unknown> };

const step = (label: string, params: Record<string, unknown>, paramBag: Record<string, unknown> = {}): Step => ({
  timestamp: 1_700_000_000_000 + label.length,
  label,
  params,
  paramBag,
});

const dab = (x: number) => ({ x, y: x / 2, size: 12 });
const mask = (id: string, dabs: number[], opacity = 100) => ({
  id,
  name: id,
  opacity,
  components: [{ kind: "brush", dabs: dabs.map(dab) }],
});

/** A history touching every kind of value a step holds. */
const HISTORY: Step[] = [
  step("Original", { exposure: 0, contrast: 0, toneCurve: { rgb: [[0, 0], [1, 1]] }, masks: [], crop: null }),
  step("Exposure", { exposure: 0.5, contrast: 0, toneCurve: { rgb: [[0, 0], [1, 1]] }, masks: [], crop: null }),
  step("Tone Curve", { exposure: 0.5, contrast: 0, toneCurve: { rgb: [[0, 0], [0.5, 0.6], [1, 1]] }, masks: [], crop: null }),
  step("Mask", { exposure: 0.5, contrast: 0, toneCurve: { rgb: [[0, 0], [0.5, 0.6], [1, 1]] }, masks: [mask("m1", [1, 2])], crop: null }),
  step("Brush", { exposure: 0.5, contrast: 0, toneCurve: { rgb: [[0, 0], [0.5, 0.6], [1, 1]] }, masks: [mask("m1", [1, 2, 3, 4])], crop: null }),
  step("Glow", { exposure: 0.5, contrast: 0, toneCurve: { rgb: [[0, 0], [0.5, 0.6], [1, 1]] }, masks: [mask("m1", [1, 2, 3, 4], 60)], crop: { x: 0.1 } }, { "glow.amount": 0.4 }),
  step("Reset", { exposure: 0, contrast: 0, masks: [] }, {}),
];

const pack = (stack: readonly Step[]) => JSON.parse(JSON.stringify(packStack(stack))) as unknown[];

describe("packStack", () => {
  it("keeps the first step and every BASE_EVERY-th whole, and stores the rest as changes", () => {
    const long = Array.from({ length: BASE_EVERY * 2 + 1 }, (_, i) => step(`S${i}`, { exposure: i }));
    const packed = packStack(long);
    const whole = packed.flatMap((entry, i) => ("params" in entry ? [i] : []));
    expect(whole).toEqual([0, BASE_EVERY, BASE_EVERY * 2]);
    expect(packed[1]).toEqual({ timestamp: long[1].timestamp, label: "S1", delta: [[["params", "exposure"], 1]] });
  });

  it("stores a slider move as that one value", () => {
    expect(packStack(HISTORY.slice(0, 2))[1]).toEqual({
      timestamp: HISTORY[1].timestamp,
      label: "Exposure",
      delta: [[["params", "exposure"], 0.5]],
    });
  });

  it("stores the dabs a brush stroke added, not the mask again", () => {
    const { delta } = packStack(HISTORY.slice(0, 5))[4] as { delta: unknown[] };
    expect(delta).toEqual([[["params", "masks", 0, "components", 0, "dabs"], 2, 0, [dab(3), dab(4)]]]);
  });

  it("stores a value removed as its path alone", () => {
    const { delta } = packStack(HISTORY)[6] as { delta: unknown[] };
    expect(delta).toContainEqual([["params", "toneCurve"]]);
    expect(delta).toContainEqual([["params", "crop"]]);
    expect(delta).toContainEqual([["paramBag", "glow.amount"]]);
  });

  it("is a fraction of the whole steps' size for a long run of slider moves", () => {
    const params = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`value${i}`, i]));
    const long = Array.from({ length: 100 }, (_, i) => step(`S${i}`, { ...params, exposure: i / 10 }));
    expect(JSON.stringify(packStack(long)).length).toBeLessThan(JSON.stringify(long).length / 4);
  });
});

describe("unpackStack", () => {
  it("gives back every step exactly as it was packed", () => {
    expect(unpackStack(pack(HISTORY))).toEqual(HISTORY);
  });

  it("gives back steps across several bases", () => {
    const long = Array.from({ length: BASE_EVERY * 2 + 3 }, (_, i) =>
      step(`S${i}`, { exposure: i, masks: [mask("m", Array.from({ length: i % 7 }, (_, d) => d))] }, i % 3 ? { "x.y": i } : {}),
    );
    expect(unpackStack(pack(long))).toEqual(long);
  });

  it("gives back steps with no params or bag, as builds before process versions wrote them", () => {
    const legacy = [{ timestamp: 1, label: "Original" }, { timestamp: 2, label: "Exposure", params: { exposure: 1 } }];
    expect(unpackStack(pack(legacy))).toEqual(legacy);
  });

  it("reads a history stored whole, as catalogues before packing hold it", () => {
    expect(unpackStack(JSON.parse(JSON.stringify(HISTORY)))).toEqual(HISTORY);
  });

  it("never changes a step by unpacking the next", () => {
    const steps = unpackStack(pack(HISTORY)) as Step[];
    expect(steps[3]).toEqual(HISTORY[3]);
    expect(steps[4].params?.masks).not.toBe(steps[3].params?.masks);
  });

  it("can't open a step whose step before can't be opened, up to the next whole one", () => {
    const long = Array.from({ length: BASE_EVERY + 2 }, (_, i) => step(`S${i}`, { exposure: i }));
    const packed = pack(long);
    packed[2] = "damaged";
    const steps = unpackStack(packed);
    expect(steps.slice(0, 2)).toEqual(long.slice(0, 2));
    expect(steps[2]).toBe("damaged");
    expect(steps.slice(3, BASE_EVERY).every((s) => s === null)).toBe(true);
    expect(steps.slice(BASE_EVERY)).toEqual(long.slice(BASE_EVERY));
  });

  it("can't open a step whose changes don't fit the step before", () => {
    const packed = pack(HISTORY.slice(0, 3));
    packed[1] = { timestamp: 1, label: "Exposure", delta: [[["params", "exposure", "deeper"], 1]] };
    expect(unpackStack(packed).slice(1)).toEqual([null, null]);
  });
});
