// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// An extension's local history (#281): the steps it made, read out of the
// photo's one history, and the look that takes only its own values back or
// forward to one of them, leaving every other tool's later edits in place.

import { describe, expect, it } from "vitest";
import { CURRENT_PROCESS_VERSION, normalizeParams, type DevelopParams, type EditSnapshot, type Mask } from "@/catalog/types";
import { chosenSource, historySources, localHistory, localLook, localMoveLabel, type HistoryPin } from "./local-history";

let clock = 1_000;

function step(
  label: string,
  params: Partial<DevelopParams>,
  extra: Partial<EditSnapshot> = {},
  paramBag: Record<string, unknown> = {},
): EditSnapshot {
  clock += 10;
  return {
    timestamp: clock,
    label,
    // Masks are kept as given: normalizing drops one without geometry.
    params: { ...normalizeParams({ processVersion: CURRENT_PROCESS_VERSION, ...params }), ...(params.masks && { masks: params.masks }) },
    paramBag,
    ...extra,
  };
}

const original = () => step("Original", {});
const labelsOf = (h: ReturnType<typeof localHistory>) => h.steps.map((s) => s.label);

describe("localHistory", () => {
  it("lists the steps one extension made, in order, standing on its latest", () => {
    const history = [
      original(),
      step("Exposure", { exposure: 1 }, { source: "basic" }),
      step("Hue", { exposure: 1 }, { source: "hsl" }),
      step("Contrast", { exposure: 1, contrast: 20 }, { source: "basic" }),
    ];
    const local = localHistory(history, 3, "basic");
    expect(local.source).toBe("basic");
    expect(local.steps.map((s) => s.index)).toEqual([1, 3]);
    expect(labelsOf(local)).toEqual(["Exposure", "Contrast"]);
    expect(local.cursor).toBe(1);
  });

  it("is empty, before any step, for an extension that made none", () => {
    const history = [original(), step("Hue", {}, { source: "hsl" })];
    expect(localHistory(history, 1, "basic")).toEqual({ source: "basic", steps: [], cursor: -1 });
  });

  it("leaves out steps saved without a source and core's own steps", () => {
    const history = [original(), step("Exposure", { exposure: 1 }), step("Reset", {})];
    expect(localHistory(history, 2, "basic").steps).toEqual([]);
  });

  it("reads only up to the step the photo shows: steps past it are the global redo", () => {
    const history = [
      original(),
      step("Exposure", { exposure: 1 }, { source: "basic" }),
      step("Contrast", { exposure: 1, contrast: 20 }, { source: "basic" }),
    ];
    const local = localHistory(history, 1, "basic");
    expect(labelsOf(local)).toEqual(["Exposure"]);
    expect(local.cursor).toBe(0);
  });

  it("follows a local undo to the step it went back to, keeping the step after as its redo", () => {
    const exposure = step("Exposure", { exposure: 1 }, { source: "basic" });
    const contrast = step("Contrast", { exposure: 1, contrast: 20 }, { source: "basic" });
    const undo = step("Undo Contrast", { exposure: 1 }, { source: "basic", local: { to: 1 } });
    const local = localHistory([original(), exposure, contrast, undo], 3, "basic");
    expect(labelsOf(local)).toEqual(["Exposure", "Contrast"]);
    expect(local.cursor).toBe(0);
  });

  it("stands before its first step after undoing it", () => {
    const exposure = step("Exposure", { exposure: 1 }, { source: "basic" });
    const undo = step("Undo Exposure", {}, { source: "basic", local: { to: null } });
    const local = localHistory([original(), exposure, undo], 2, "basic");
    expect(labelsOf(local)).toEqual(["Exposure"]);
    expect(local.cursor).toBe(-1);
  });

  it("drops its redo steps when the extension makes a new change, as undo always does", () => {
    const exposure = step("Exposure", { exposure: 1 }, { source: "basic" });
    const contrast = step("Contrast", { exposure: 1, contrast: 20 }, { source: "basic" });
    const undo = step("Undo Contrast", { exposure: 1 }, { source: "basic", local: { to: 1 } });
    const shadows = step("Shadows", { exposure: 1, shadows: 30 }, { source: "basic" });
    const local = localHistory([original(), exposure, contrast, undo, shadows], 4, "basic");
    expect(labelsOf(local)).toEqual(["Exposure", "Shadows"]);
    expect(local.cursor).toBe(1);
  });

  it("is not moved by another extension's local undo", () => {
    const exposure = step("Exposure", { exposure: 1 }, { source: "basic" });
    const hue = step("Hue", { exposure: 1 }, { source: "hsl" });
    const undoHue = step("Undo Hue", { exposure: 1 }, { source: "hsl", local: { to: null } });
    expect(localHistory([original(), exposure, hue, undoHue], 3, "basic").cursor).toBe(0);
  });

  it("ignores a source or local move that isn't the right shape", () => {
    const odd = { ...step("Odd", { exposure: 1 }), source: 7 } as unknown as EditSnapshot;
    const badMove = { ...step("Bad", {}, { source: "basic" }), local: "x" } as unknown as EditSnapshot;
    const local = localHistory([original(), odd, badMove], 2, "basic");
    expect(labelsOf(local)).toEqual(["Bad"]);
  });
});

describe("historySources", () => {
  it("lists every extension with a step the photo shows, the latest edited first", () => {
    const history = [
      original(),
      step("Exposure", {}, { source: "basic" }),
      step("Hue", {}, { source: "hsl" }),
      step("Contrast", {}, { source: "basic" }),
      step("Reset", {}),
      step("Grain", {}, { source: "effects" }),
    ];
    expect(historySources(history, 4)).toEqual(["basic", "hsl"]);
    expect(historySources(history, 5)).toEqual(["effects", "basic", "hsl"]);
  });
});

describe("chosenSource", () => {
  const history = [
    original(),
    step("Exposure", {}, { source: "basic" }),
    step("Hue", {}, { source: "hsl" }),
  ];
  const pin = (source: string, photoId = "p1"): HistoryPin => ({ photoId, source });

  it("follows the extension behind the latest step", () => {
    expect(chosenSource(history, 2, "p1", null)).toBe("hsl");
    expect(chosenSource(history, 1, "p1", null)).toBe("basic");
    expect(chosenSource(history, 0, "p1", null)).toBeNull();
  });

  it("is the pinned extension on the photo it was pinned on", () => {
    expect(chosenSource(history, 2, "p1", pin("basic"))).toBe("basic");
    expect(chosenSource(history, 2, "p1", pin("basic", "p2"))).toBe("hsl");
  });
});

describe("localLook", () => {
  const live = (s: EditSnapshot) => ({ params: s.params, paramBag: s.paramBag ?? {} });

  it("takes back only the values the extension's steps changed, keeping others' later edits", () => {
    const exposure = step("Exposure", { exposure: 1 }, { source: "basic" });
    const contrast = step("Contrast", { exposure: 1, contrast: 20 }, { source: "basic" });
    const hue = step("Saturation", { exposure: 1, contrast: 20, saturation: 15 }, { source: "hsl" });
    const history = [original(), exposure, contrast, hue];
    const local = localHistory(history, 3, "basic");

    const back = localLook(history, local, 0, live(hue));
    expect(back.params.exposure).toBe(1);
    expect(back.params.contrast).toBe(0);
    expect(back.params.saturation).toBe(15);

    const start = localLook(history, local, -1, live(hue));
    expect(start.params.exposure).toBe(0);
    expect(start.params.contrast).toBe(0);
    expect(start.params.saturation).toBe(15);
  });

  it("brings a step back forward", () => {
    const exposure = step("Exposure", { exposure: 1 }, { source: "basic" });
    const contrast = step("Contrast", { exposure: 1, contrast: 20 }, { source: "basic" });
    const undo = step("Undo Contrast", { exposure: 1 }, { source: "basic", local: { to: 1 } });
    const history = [original(), exposure, contrast, undo];
    const local = localHistory(history, 3, "basic");
    expect(localLook(history, local, 1, live(undo)).params.contrast).toBe(20);
  });

  it("puts the extension's own values back and removes ones it added, never the computed ones", () => {
    const first = step("Amount", {}, { source: "fx" }, { "fx.stage.amount": 0.4 });
    const second = step("Radius", {}, { source: "fx" }, { "fx.stage.amount": 0.6, "fx.stage.radius": 3 });
    const other = step("Other", {}, { source: "other" }, {
      "fx.stage.amount": 0.6,
      "fx.stage.radius": 3,
      "other.stage.k": 1,
    });
    const history = [original(), first, second, other];
    const local = localHistory(history, 3, "fx");
    const back = localLook(history, local, 0, live(other));
    expect(back.paramBag).toEqual({ "fx.stage.amount": 0.4, "other.stage.k": 1 });
    const start = localLook(history, local, -1, live(other));
    expect(start.paramBag).toEqual({ "other.stage.k": 1 });
  });

  it("takes back a mask the extension changed without touching the others", () => {
    const mask = (id: string, opacity: number) => ({ id, name: id, opacity }) as Mask;
    const a = step("Add A", { masks: [mask("a", 100)] }, { source: "masking" });
    const edit = step("Mask exposure", { masks: [mask("a", 40)] }, { source: "basic" });
    const b = step("Add B", { masks: [mask("a", 40), mask("b", 100)] }, { source: "masking" });
    const history = [original(), a, edit, b];
    const local = localHistory(history, 3, "basic");
    const back = localLook(history, local, -1, live(b));
    expect(back.params.masks.map((m) => [m.id, m.opacity])).toEqual([
      ["a", 100],
      ["b", 100],
    ]);
  });

  it("never moves the process version", () => {
    const legacy = step("Exposure", { exposure: 1, processVersion: 1 }, { source: "basic" });
    const updated = step("Update", { exposure: 1, processVersion: CURRENT_PROCESS_VERSION });
    const history = [step("Original", { processVersion: 1 }), legacy, updated];
    const local = localHistory(history, 2, "basic");
    const back = localLook(history, local, -1, live(updated));
    expect(back.params.processVersion).toBe(CURRENT_PROCESS_VERSION);
    expect(back.params.exposure).toBe(0);
  });
});

describe("localMoveLabel", () => {
  const exposure = step("Exposure", { exposure: 1 }, { source: "basic" });
  const contrast = step("Contrast", { contrast: 20 }, { source: "basic" });
  const shadows = step("Shadows", { shadows: 20 }, { source: "basic" });
  const history = [original(), exposure, contrast, shadows];

  it("names one step back or forward after the step it undoes or redoes", () => {
    const local = localHistory(history, 3, "basic");
    expect(localMoveLabel(local, 1)).toBe("Undo Shadows");
    const atFirst = { ...local, cursor: 0 };
    expect(localMoveLabel(atFirst, 1)).toBe("Redo Contrast");
  });

  it("names a longer move after the step it lands on", () => {
    const local = localHistory(history, 3, "basic");
    expect(localMoveLabel(local, 0)).toBe("Undo to Exposure");
    expect(localMoveLabel(local, -1)).toBe("Undo to Original");
    expect(localMoveLabel({ ...local, cursor: -1 }, 2)).toBe("Redo to Shadows");
  });
});
