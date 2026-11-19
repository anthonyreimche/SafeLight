// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// api.devtools.render: the live view's status, the standing stage failures and the
// values the live view drew a stage with.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { devtoolsRender } from "./devtools-render";
import { forgetStageFailures, recordStageFailure } from "./stage-failures";
import { noteLiveFrame, resetLiveStatus, setLiveViewSource } from "./live-status";
import { GPU_CRASH_LOG } from "../gpu-crash-guard";
import { registerProcessingStage, unregisterExtension } from "@/extensions/registry";
import type { ProcessingStageContribution } from "@/extensions/types";
import { stageSignature } from "../webgl/stage-injection";

const stage = (id: string, glsl = "c *= 1.0;"): ProcessingStageContribution => ({
  id,
  name: id,
  phase: "effects",
  glsl,
  uniforms: [],
});

const failureOf = (s: ProcessingStageContribution, log: string) => ({
  stageId: s.id,
  signature: stageSignature(s),
  log,
});

beforeEach(() => {
  forgetStageFailures();
  resetLiveStatus();
});

afterEach(() => {
  unregisterExtension("acme");
  unregisterExtension("beta");
  setLiveViewSource(null);
});

describe("devtoolsRender.live", () => {
  it("is null until a live frame, then follows the store", () => {
    expect(devtoolsRender.live.get()).toBeNull();
    setLiveViewSource({ photoId: () => "p1", processVersion: () => 3 });
    const listener = vi.fn();
    const off = devtoolsRender.live.subscribe(listener);
    noteLiveFrame({ overflowed: [], frameMs: 4 });
    expect(listener).toHaveBeenCalledOnce();
    expect(devtoolsRender.live.get()).toMatchObject({ photoId: "p1", processVersion: 3 });
    off();
  });

  it("is a hook that returns the same status until it changes", () => {
    setLiveViewSource({ photoId: () => "p1", processVersion: () => 3 });
    noteLiveFrame({ overflowed: [], frameMs: 4 });
    const { result, rerender } = renderHook(() => devtoolsRender.live.use());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
    act(() => noteLiveFrame({ overflowed: ["x"], frameMs: 4 }));
    expect(result.current?.overflowed).toEqual(["x"]);
  });
});

describe("devtoolsRender.stageFailures", () => {
  it("lists the standing failures of every extension's stages by stage id", () => {
    const a = stage("acme.film");
    const b = stage("beta.grain");
    registerProcessingStage("acme", a);
    registerProcessingStage("beta", b);
    recordStageFailure(failureOf(a, "Shader compile failed: nope"));
    recordStageFailure(failureOf(b, GPU_CRASH_LOG));
    expect(devtoolsRender.stageFailures.get()).toEqual({
      "acme.film": { log: "Shader compile failed: nope", crashed: false },
      "beta.grain": { log: GPU_CRASH_LOG, crashed: true },
    });
  });

  it("leaves out a failure of a stage registered again with anything changed, and of one that is gone", () => {
    const a = stage("acme.film");
    registerProcessingStage("acme", a);
    recordStageFailure(failureOf(a, "bad"));
    recordStageFailure(failureOf(stage("acme.gone"), "bad"));
    registerProcessingStage("acme", stage("acme.film", "c *= 2.0;"));
    expect(devtoolsRender.stageFailures.get()).toEqual({});
  });

  it("returns the same object while nothing it lists has changed, and as a hook too", () => {
    const a = stage("acme.film");
    registerProcessingStage("acme", a);
    recordStageFailure(failureOf(a, "bad"));
    const first = devtoolsRender.stageFailures.get();
    expect(devtoolsRender.stageFailures.get()).toBe(first);
    recordStageFailure(failureOf(stage("acme.gone"), "bad"));
    expect(devtoolsRender.stageFailures.get()).toBe(first);
    const { result, rerender } = renderHook(() => devtoolsRender.stageFailures.use());
    rerender();
    expect(result.current).toBe(first);
  });

  it("tells a subscriber when a failure stands or stops standing", () => {
    const a = stage("acme.film");
    registerProcessingStage("acme", a);
    const listener = vi.fn();
    const off = devtoolsRender.stageFailures.subscribe(listener);
    recordStageFailure(failureOf(a, "bad"));
    expect(listener).toHaveBeenCalled();
    off();
  });
});

describe("devtoolsRender.liveValues", () => {
  it("is null with no live view", () => {
    expect(devtoolsRender.liveValues("acme.film")).toBeNull();
  });
});
