// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// @vitest-environment jsdom

// A stage whose shader takes the graphics driver down (Saturation Curve 1.0.0
// on Direct3D 11) lost the context, and the window that reloaded built it again,
// until Chromium blocked WebGL and Safelight fell back to software. The guard
// notes which stages a build has in hand, so a lost context or a window that
// died mid-build pins the crash on the ones that never built on this machine,
// and every renderer leaves them out from then on.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessingStageContribution } from "@/extensions/types";

type Guard = typeof import("./gpu-crash-guard");

const stage = (id: string, glsl = "c = c;"): ProcessingStageContribution => ({
  id,
  name: id,
  phase: "effects",
  glsl,
  uniforms: [],
});
const CURVE = stage("acme.curve");
const GRAIN = stage("acme.grain");

/** The guard as a freshly loaded window finds it. */
async function load(): Promise<Guard> {
  vi.resetModules();
  return import("./gpu-crash-guard");
}

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("the GPU crash guard", () => {
  it("pins a lost context on the stages a build had in hand", async () => {
    const guard = await load();
    guard.noteBuildStarted([guard.stageKey(CURVE), guard.stageKey(GRAIN)]);
    expect(guard.blameLostContext()).toEqual([guard.stageKey(CURVE), guard.stageKey(GRAIN)]);
    expect(guard.isCrashed(CURVE)).toBe(true);
    expect(guard.isCrashed(GRAIN)).toBe(true);
  });

  it("spares a stage that has built on this machine before", async () => {
    const guard = await load();
    guard.noteBuildStarted([guard.stageKey(GRAIN)]);
    guard.noteBuildEnded([guard.stageKey(GRAIN)], "built");
    guard.noteBuildStarted([guard.stageKey(GRAIN), guard.stageKey(CURVE)]);
    expect(guard.blameLostContext()).toEqual([guard.stageKey(CURVE)]);
    expect(guard.isCrashed(GRAIN)).toBe(false);
  });

  it("blames nothing for a build that ended, unless it failed without a log", async () => {
    const guard = await load();
    guard.noteBuildStarted([guard.stageKey(GRAIN)]);
    guard.noteBuildEnded([guard.stageKey(GRAIN)], "failed");
    expect(guard.blameLostContext()).toEqual([]);

    guard.noteBuildStarted([guard.stageKey(CURVE)]);
    guard.noteBuildEnded([guard.stageKey(CURVE)], "suspect");
    expect(guard.blameLostContext()).toEqual([guard.stageKey(CURVE)]);
  });

  it("keeps the blame for the window a crash reloads", async () => {
    const first = await load();
    first.noteBuildStarted([first.stageKey(CURVE)]);
    first.blameLostContext();

    const reloaded = await load();
    expect(reloaded.isCrashed(CURVE)).toBe(true);
  });

  describe("a build the last window died in", () => {
    it("is blamed as the window starts, before any renderer builds it", async () => {
      const first = await load();
      first.noteBuildStarted([first.stageKey(CURVE)]);

      const reloaded = await load();
      expect(reloaded.isCrashed(CURVE)).toBe(true);
    });

    it("stays blamed when the graphics process crashed after it began", async () => {
      const first = await load();
      first.noteBuildStarted([first.stageKey(CURVE)]);
      const reloaded = await load();
      const cleared = await reloaded.settleLeftoverBuild(async () => [
        { time: Date.now() + 1, process: "GPU", reason: "crashed", exitCode: -1073741819 },
      ]);
      expect(cleared).toEqual([]);
      expect(reloaded.isCrashed(CURVE)).toBe(true);
    });

    it("is forgiven when nothing crashed: the window was closed or reloaded mid-build", async () => {
      const first = await load();
      first.noteBuildStarted([first.stageKey(CURVE)]);
      const reloaded = await load();
      const cleared = await reloaded.settleLeftoverBuild(async () => [
        { time: Date.now() + 1, process: "renderer", reason: "crashed", exitCode: 1 },
      ]);
      expect(cleared).toEqual([reloaded.stageKey(CURVE)]);
      expect(reloaded.isCrashed(CURVE)).toBe(false);
    });

    it("stays blamed when the crash log can't be read", async () => {
      const first = await load();
      first.noteBuildStarted([first.stageKey(CURVE)]);
      const reloaded = await load();
      expect(await reloaded.settleLeftoverBuild(async () => undefined)).toEqual([]);
      expect(reloaded.isCrashed(CURVE)).toBe(true);
    });
  });

  it("tries a stage again once it is registered changed", async () => {
    const guard = await load();
    guard.noteBuildStarted([guard.stageKey(CURVE)]);
    guard.blameLostContext();
    expect(guard.isCrashed(stage("acme.curve", "c = c * 0.5;"))).toBe(false);
  });

  it("tries a stage again once its extension is turned off and on", async () => {
    const guard = await load();
    guard.noteBuildStarted([guard.stageKey(CURVE), guard.stageKey(GRAIN)]);
    guard.blameLostContext();
    guard.forgetCrashesOf([CURVE.id]);
    expect(guard.isCrashed(CURVE)).toBe(false);
    expect(guard.isCrashed(GRAIN)).toBe(true);
  });

  it("tells its listeners when the stages it leaves out change", async () => {
    const guard = await load();
    const heard = vi.fn();
    const stop = guard.subscribeCrashes(heard);
    guard.noteBuildStarted([guard.stageKey(CURVE)]);
    guard.blameLostContext();
    guard.forgetCrashesOf([CURVE.id]);
    stop();
    guard.noteBuildStarted([guard.stageKey(GRAIN)]);
    guard.blameLostContext();
    expect(heard).toHaveBeenCalledTimes(2);
  });

  describe("withoutCrashed", () => {
    it("leaves the blamed stages out of an array or the registry's record", async () => {
      const guard = await load();
      guard.noteBuildStarted([guard.stageKey(CURVE)]);
      guard.blameLostContext();
      expect(guard.withoutCrashed([CURVE, GRAIN])).toEqual([GRAIN]);
      expect(guard.withoutCrashed({ [CURVE.id]: CURVE, [GRAIN.id]: GRAIN })).toEqual([GRAIN]);
    });

    // A renderer rebuilds its stage injection whenever its source is a new object.
    it("hands back the same object for the same stages while the blame stands", async () => {
      const guard = await load();
      const registered = { [CURVE.id]: CURVE, [GRAIN.id]: GRAIN };
      expect(guard.withoutCrashed(registered)).toBe(registered);
      guard.noteBuildStarted([guard.stageKey(CURVE)]);
      guard.blameLostContext();
      const first = guard.withoutCrashed(registered);
      expect(guard.withoutCrashed(registered)).toBe(first);
    });
  });
});
