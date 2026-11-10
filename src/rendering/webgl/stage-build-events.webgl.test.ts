// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A renderer says which extension stages each program build has in hand and how
// it ended, so the window can pin a build that takes the graphics driver down on
// the stages in it (gpu-crash-guard.ts).

import { describe, expect, it } from "vitest";
import type { ProcessingStageContribution } from "@/extensions/types";
import type { StageBuildEvent } from "./renderer";
import { stageSignature } from "./stage-injection";
import { LINEAR_PROBE_PIPELINE, floatImage, identityParams, withRenderer } from "./webgl.test-support";

const SOURCE = floatImage(8, 8, (x, y) => [x / 8, y / 8, 0.3]);

const stage = (id: string, glsl: string): ProcessingStageContribution => ({
  id,
  name: id,
  phase: "scene-linear",
  glsl,
  uniforms: [],
});
const DOUBLE_RED = stage("acme.red", "lin.r *= 2.0;");
const BROKEN = stage("acme.broken", "lin = lin *;");
const PASSED: ProcessingStageContribution = {
  id: "acme.passed",
  name: "Passed",
  phase: "decode",
  uniforms: [{ key: "n", glslType: "float", default: 1 }],
  passes: [{ glsl: "c = vec3(0.25);", iterations: { key: "n", max: 4 } }],
  glsl: "lin = stageResult;",
};

const key = (s: ProcessingStageContribution) => `${s.id}:${stageSignature(s)}`;

function drawnWith(stages: ProcessingStageContribution[]): StageBuildEvent[] {
  const events: StageBuildEvent[] = [];
  const logError = console.error;
  console.error = () => {};
  try {
    withRenderer({ stages, pipeline: LINEAR_PROBE_PIPELINE, onStageBuild: (e) => events.push(e) }, (renderer) => {
      renderer.setImage(SOURCE);
      renderer.setParams(identityParams());
      renderer.render();
    });
  } finally {
    console.error = logError;
  }
  // Draws are covered by stage-draw-events.webgl.test.ts.
  return events.filter((e) => e.phase === "start" || e.phase === "end");
}

describe("a renderer's stage build events", () => {
  it("name the extension stages a develop program build has in hand, and that it built", () => {
    expect(drawnWith([DOUBLE_RED])).toEqual([
      { phase: "start", stages: [key(DOUBLE_RED)] },
      { phase: "end", stages: [key(DOUBLE_RED)], outcome: "built" },
    ]);
  });

  it("say nothing of a build of Safelight's own stages alone", () => {
    expect(drawnWith([])).toEqual([]);
  });

  it("end a build that fails with a compile log as failed, not as a driver failure", () => {
    const ends = drawnWith([DOUBLE_RED, BROKEN]).filter((e) => e.phase === "end");
    expect(ends.some((e) => e.outcome === "failed" && e.stages.includes(key(BROKEN)))).toBe(true);
    expect(ends.some((e) => e.outcome === "suspect")).toBe(false);
  });

  it("cover a stage's pass program too", () => {
    const events = drawnWith([PASSED]);
    const starts = events.filter((e) => e.phase === "start");
    expect(starts.length).toBeGreaterThanOrEqual(2);
    expect(starts.every((e) => e.stages.length === 1 && e.stages[0] === key(PASSED))).toBe(true);
    expect(events.filter((e) => e.phase === "end").every((e) => e.outcome === "built")).toBe(true);
  });
});
