// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Pipeline order: phase, then priority, then the order given, with `after` as a
// soft dependency inside a phase. The injection and the test-only compiler both
// order through sortStages, so what is pinned here holds for both.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessingPhase, ProcessingStageContribution } from "@/extensions/types";

// sortStages remembers the cycles it has reported, so every test gets a fresh
// copy of the module and starts with none.
let sortStages: typeof import("./stage-order").sortStages;

beforeEach(async () => {
  vi.resetModules();
  ({ sortStages } = await import("./stage-order"));
});

const stage = (
  id: string,
  over: Partial<ProcessingStageContribution> = {},
): ProcessingStageContribution => ({
  id,
  name: id,
  phase: "scene-linear",
  glsl: "",
  uniforms: [],
  ...over,
});

/** A stage as plain-JavaScript extensions can write it: any value in any field. */
const plainJs = (id: string, fields: Record<string, unknown>): ProcessingStageContribution =>
  ({ ...stage(id), ...fields }) as ProcessingStageContribution;

/** A phase name the order doesn't list, as a plain-JavaScript extension can give. */
const unlistedPhase = (name: string): ProcessingPhase => name as ProcessingPhase;

const order = (stages: readonly ProcessingStageContribution[]): string[] =>
  sortStages(stages).map((s) => s.id);

const quietWarn = () => vi.spyOn(console, "warn").mockImplementation(() => {});
const messages = (warn: ReturnType<typeof quietWarn>): string[] =>
  warn.mock.calls.map((call) => String(call[0]));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("without after", () => {
  it("orders by phase, then priority, then the order given", () => {
    const stages = [
      stage("effects.late", { phase: "effects", priority: 200 }),
      stage("scene.b"),
      stage("scene.fast", { priority: 10 }),
      stage("geo", { phase: "geometry" }),
      stage("scene.a", { priority: 100 }),
      stage("effects.early", { phase: "effects", priority: 5 }),
      stage("decode", { phase: "decode" }),
    ];
    // scene.b and scene.a tie at the default priority: the order given decides.
    expect(order(stages)).toEqual([
      "geo",
      "decode",
      "scene.fast",
      "scene.b",
      "scene.a",
      "effects.early",
      "effects.late",
    ]);
  });

  it("puts a phase the order doesn't list after every listed one", () => {
    const odd = stage("odd", { phase: unlistedPhase("post-effects"), priority: 1 });
    expect(order([odd, stage("out", { phase: "output-encode" })])).toEqual(["out", "odd"]);
  });

  it("leaves the list it was given as it was", () => {
    const given = [stage("b", { priority: 20 }), stage("a", { priority: 10 })];
    sortStages(given);
    expect(given.map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("orders nothing", () => {
    expect(sortStages([])).toEqual([]);
  });
});

describe("after", () => {
  it("runs a stage after the stage it names, against its priority", () => {
    expect(order([stage("late", { priority: 10, after: ["base"] }), stage("base")])).toEqual([
      "base",
      "late",
    ]);
    // Without the name, priority puts it first.
    expect(order([stage("late", { priority: 10 }), stage("base")])).toEqual(["late", "base"]);
  });

  it("leaves every other stage where priority puts it", () => {
    const stages = [
      stage("a", { priority: 10, after: ["b"] }),
      stage("c", { priority: 50 }),
      stage("b", { priority: 100 }),
    ];
    expect(order(stages)).toEqual(["c", "b", "a"]);
  });

  it("follows a chain of names", () => {
    const stages = [
      stage("c", { priority: 10, after: ["b"] }),
      stage("b", { priority: 20, after: ["a"] }),
      stage("a", { priority: 30 }),
    ];
    expect(order(stages)).toEqual(["a", "b", "c"]);
  });

  it("waits for every stage it lists", () => {
    const stages = [
      stage("z", { priority: 10, after: ["x", "y"] }),
      stage("x", { priority: 20 }),
      stage("y", { priority: 30 }),
    ];
    expect(order(stages)).toEqual(["x", "y", "z"]);
  });

  it("keeps the order given between stages that are released together", () => {
    const released = (first: string, second: string) => [
      stage(first, { after: ["z"] }),
      stage(second, { after: ["z"] }),
      stage("z", { priority: 200 }),
    ];
    expect(order(released("p", "q"))).toEqual(["z", "p", "q"]);
    expect(order(released("q", "p"))).toEqual(["z", "q", "p"]);
  });

  it("moves nothing that priority already orders", () => {
    const stages = [stage("b", { priority: 20, after: ["a"] }), stage("a", { priority: 10 })];
    expect(order(stages)).toEqual(["a", "b"]);
  });

  it("names a stage given after it as well as one given before", () => {
    const stages = [
      stage("first", { priority: 10, after: ["last"] }),
      stage("last", { priority: 90 }),
    ];
    expect(order(stages)).toEqual(["last", "first"]);
    expect(order([...stages].reverse())).toEqual(["last", "first"]);
  });

  it("is a soft dependency: an id that isn't registered is ignored, without a warning", () => {
    const warn = quietWarn();
    const stages = [stage("x", { priority: 10, after: ["gone"] }), stage("y", { priority: 20 })];
    expect(order(stages)).toEqual(["x", "y"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("ignores an id from another phase: a phase boundary always wins", () => {
    const warn = quietWarn();
    const scene = stage("scene", { priority: 10, after: ["fx"] });
    const effects = stage("fx", { phase: "effects" });
    expect(order([scene, effects])).toEqual(["scene", "fx"]);
    expect(order([effects, scene])).toEqual(["scene", "fx"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("never reads two phases naming each other as a cycle", () => {
    const warn = quietWarn();
    const stages = [
      stage("scene", { after: ["fx"] }),
      stage("fx", { phase: "effects", after: ["scene"] }),
    ];
    expect(order(stages)).toEqual(["scene", "fx"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("orders each phase on its own", () => {
    const stages = [
      stage("fx.late", { phase: "effects", priority: 10, after: ["fx.base"] }),
      stage("fx.base", { phase: "effects" }),
      stage("scene.late", { priority: 10, after: ["scene.base"] }),
      stage("scene.base"),
    ];
    expect(order(stages)).toEqual(["scene.base", "scene.late", "fx.base", "fx.late"]);
  });

  it("ignores a stage naming itself", () => {
    const warn = quietWarn();
    const stages = [stage("a", { priority: 10, after: ["a"] }), stage("b", { priority: 20 })];
    expect(order(stages)).toEqual(["a", "b"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("ignores an after that isn't a list, since extensions are plain JavaScript", () => {
    const warn = quietWarn();
    for (const after of ["b", 3, null, { 0: "b" }]) {
      const stages = [plainJs("a", { priority: 10, after }), stage("b", { priority: 20 })];
      expect(order(stages), String(after)).toEqual(["a", "b"]);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("reads a list entry that isn't an id as naming nothing", () => {
    const stages = [
      plainJs("a", { priority: 10, after: [null, 4, "b"] }),
      stage("b", { priority: 20 }),
    ];
    expect(order(stages)).toEqual(["b", "a"]);
  });

  it("orders a diamond of names, which is no cycle", () => {
    const warn = quietWarn();
    const stages = [
      stage("top", { priority: 10, after: ["left", "right"] }),
      stage("left", { priority: 20, after: ["bottom"] }),
      stage("right", { priority: 30, after: ["bottom"] }),
      stage("bottom", { priority: 40 }),
    ];
    expect(order(stages)).toEqual(["bottom", "left", "right", "top"]);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("a cycle in after", () => {
  it("ignores the entries between its stages, so priority orders them, and warns once", () => {
    const warn = quietWarn();
    const stages = [
      stage("a", { priority: 10, after: ["b"] }),
      stage("b", { priority: 20, after: ["a"] }),
    ];
    expect(order(stages)).toEqual(["a", "b"]);
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = messages(warn);
    expect(message).toContain('"a"');
    expect(message).toContain('"b"');
    expect(message).toMatch(/after/);
    // Says what is dropped, and no more: other entries of the members still count.
    expect(message).toMatch(/only the entries between them are ignored/);
    expect(message).not.toMatch(/priority/);
  });

  it("does the same for a longer loop, in one warning", () => {
    const warn = quietWarn();
    const stages = [
      stage("a", { priority: 10, after: ["c"] }),
      stage("b", { priority: 20, after: ["a"] }),
      stage("c", { priority: 30, after: ["b"] }),
    ];
    expect(order(stages)).toEqual(["a", "b", "c"]);
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = messages(warn);
    for (const id of ["a", "b", "c"]) expect(message).toContain(`"${id}"`);
  });

  it("changes nothing else, and names only the stages in the cycle", () => {
    const warn = quietWarn();
    const stages = [
      stage("a", { priority: 10, after: ["b"] }),
      stage("b", { priority: 30, after: ["a"] }),
      stage("x", { priority: 20 }),
      // Not in the cycle, though it waits on a stage that is.
      stage("y", { priority: 5, after: ["a"] }),
    ];
    expect(order(stages)).toEqual(["a", "y", "x", "b"]);
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = messages(warn);
    expect(message).toContain('"a"');
    expect(message).toContain('"b"');
    expect(message).not.toContain('"x"');
    expect(message).not.toContain('"y"');
  });

  it("drops the cycle's own entries only: a member still waits for a stage outside it", () => {
    const warn = quietWarn();
    const stages = [
      stage("a", { priority: 10, after: ["b", "c"] }),
      stage("b", { priority: 20, after: ["a"] }),
      stage("c", { priority: 30 }),
    ];
    expect(order(stages)).toEqual(["b", "c", "a"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(messages(warn)[0]).not.toContain('"c"');
  });

  it("warns once for each cycle", () => {
    const warn = quietWarn();
    const stages = [
      stage("a", { priority: 10, after: ["b"] }),
      stage("b", { priority: 20, after: ["a"] }),
      stage("c", { priority: 30, after: ["d"] }),
      stage("d", { priority: 40, after: ["c"] }),
    ];
    expect(order(stages)).toEqual(["a", "b", "c", "d"]);
    const [first, second] = messages(warn);
    expect(warn).toHaveBeenCalledTimes(2);
    expect([first.includes('"a"'), first.includes('"b"')]).toEqual([true, true]);
    expect([second.includes('"c"'), second.includes('"d"')]).toEqual([true, true]);
  });

  // The renderer orders the same stages for each process version, for each
  // renderer it runs, and again whenever the stage set changes: one cycle would
  // be logged every time.
  it("reports a cycle once, however many times the stages are ordered", () => {
    const warn = quietWarn();
    const stages = [
      stage("a", { priority: 10, after: ["b"] }),
      stage("b", { priority: 20, after: ["a"] }),
    ];
    for (let build = 0; build < 3; build++) expect(order(stages)).toEqual(["a", "b"]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("knows a cycle by its members, whatever order they run in", () => {
    const warn = quietWarn();
    order([stage("a", { priority: 10, after: ["b"] }), stage("b", { priority: 20, after: ["a"] })]);
    order([stage("a", { priority: 20, after: ["b"] }), stage("b", { priority: 10, after: ["a"] })]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("reports a cycle with other members, even one that shares a stage with a reported one", () => {
    const warn = quietWarn();
    order([stage("a", { priority: 10, after: ["b"] }), stage("b", { priority: 20, after: ["a"] })]);
    order([
      stage("a", { priority: 10, after: ["c"] }),
      stage("b", { priority: 20, after: ["a"] }),
      stage("c", { priority: 30, after: ["b"] }),
    ]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(messages(warn)[1]).toContain('"c"');
  });

  it("keeps an entry that leads from one cycle into another", () => {
    const warn = quietWarn();
    const stages = [
      stage("y1", { priority: 5, after: ["y2", "x2"] }),
      stage("y2", { priority: 6, after: ["y1"] }),
      stage("x1", { priority: 10, after: ["x2"] }),
      stage("x2", { priority: 20, after: ["x1"] }),
    ];
    // y1 stays behind x2, against its priority; y2 has nothing left to wait for.
    expect(order(stages)).toEqual(["y2", "x1", "x2", "y1"]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("leaves the other phases' names working", () => {
    const warn = quietWarn();
    const stages = [
      stage("fx.a", { phase: "effects", priority: 10, after: ["fx.b"] }),
      stage("fx.b", { phase: "effects", priority: 20, after: ["fx.a"] }),
      stage("scene.late", { priority: 10, after: ["scene.base"] }),
      stage("scene.base"),
    ];
    expect(order(stages)).toEqual(["scene.base", "scene.late", "fx.a", "fx.b"]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
