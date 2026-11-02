// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Finding the stages a develop program fails to build with, by building it with
// fewer of them. Every build is a whole develop compile, so the count matters as
// much as the answer.

import { describe, expect, it } from "vitest";
import { isolateFailingStages } from "./program-cache";

const STAGES = ["a", "b", "c", "d", "e", "f", "g", "h"];

/** A build that fails with a log naming each broken stage it is handed. */
function breaksWith(broken: readonly string[]) {
  const subsets: string[][] = [];
  const build = (subset: readonly string[]): string | null => {
    subsets.push([...subset]);
    const bad = subset.filter((s) => broken.includes(s));
    return bad.length > 0 ? `'${bad[0]}' : undeclared identifier` : null;
  };
  return { build, subsets };
}

describe("isolateFailingStages", () => {
  it("names the one stage whose GLSL doesn't compile, with its log", () => {
    const { build, subsets } = breaksWith(["e"]);
    const failing = isolateFailingStages(STAGES, "the whole set failed", build);
    expect(failing).toEqual([{ stage: "e", log: "'e' : undeclared identifier" }]);
    // The stock build, a bisection of eight, and the set without it.
    expect(subsets.length).toBeLessThanOrEqual(5);
  });

  it("names each of several broken stages", () => {
    const { build } = breaksWith(["b", "g"]);
    const failing = isolateFailingStages(STAGES, "the whole set failed", build);
    expect(failing.map((f) => f.stage)).toEqual(["b", "g"]);
  });

  it("blames the stage that carries the set past a limit", () => {
    const build = (subset: readonly string[]) => (subset.length > 6 ? "too many uniforms" : null);
    const failing = isolateFailingStages(STAGES, "too many uniforms", build);
    expect(failing.map((f) => f.stage)).toEqual(["g", "h"]);
    expect(failing[0].log).toBe("too many uniforms");
  });

  it("blames none when the program fails without any of them", () => {
    const { build, subsets } = breaksWith([]);
    const fails = (subset: readonly string[]) => build(subset) ?? "the base shader failed";
    expect(isolateFailingStages(STAGES, "the base shader failed", fails)).toEqual([]);
    expect(subsets).toEqual([[]]);
  });

  // A lost context fails every build after it, whatever it holds: nothing found
  // then is to blame.
  it("blames none once the builds can no longer be trusted", () => {
    const { build, subsets } = breaksWith(["e"]);
    let lost = false;
    const losing = (subset: readonly string[]) => {
      const result = build(subset);
      lost = true;
      return result;
    };
    expect(isolateFailingStages(STAGES, "the whole set failed", losing, undefined, () => lost)).toEqual([]);
    expect(subsets).toEqual([[]]);
  });

  it("stops at its build limit, keeping what it found", () => {
    const { build, subsets } = breaksWith(["a", "b", "c", "d"]);
    const failing = isolateFailingStages(STAGES, "the whole set failed", build, 6);
    expect(subsets.length).toBe(6);
    expect(failing.length).toBeGreaterThan(0);
    expect(failing.length).toBeLessThan(4);
  });
});
