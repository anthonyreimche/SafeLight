// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessingStageContribution } from "@/extensions/types";
import { useRegistry, type RegisteredProcessingStage } from "@/extensions/registry";
import { unwireBridge, wireBridge } from "./wiring";

function stage(id: string): RegisteredProcessingStage {
  return { id, extensionId: "acme.ext", fragment: "", uniforms: [] } as unknown as RegisteredProcessingStage &
    ProcessingStageContribution;
}

function fakeBridge() {
  return {
    render: vi.fn(),
    setStageTextures: vi.fn(),
    patchStageTextures: vi.fn(),
    setCacheBudget: vi.fn(),
    setMonitorTransform: vi.fn(),
    setDisplaySpace: vi.fn(),
    syncStages: vi.fn(),
    syncPipeline: vi.fn(),
  };
}

let frames: (() => void)[];
const runFrame = () => {
  const due = frames;
  frames = [];
  for (const run of due) run();
};

beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (run: () => void) => frames.push(run));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  useRegistry.setState({ processingStages: {} });
});

afterEach(() => {
  unwireBridge();
  vi.unstubAllGlobals();
  useRegistry.setState({ processingStages: {} });
});

describe("wiring the stages to the render bridge", () => {
  it("posts the stages at most once a frame while extensions register across three frames", () => {
    const bridge = fakeBridge();
    wireBridge(bridge);
    let n = 0;
    const register = (count: number) => {
      for (let i = 0; i < count; i++) {
        const id = `acme.stage${n++}`;
        useRegistry.setState((s) => ({ processingStages: { ...s.processingStages, [id]: stage(id) } }));
      }
    };

    register(4);
    expect(bridge.syncStages).not.toHaveBeenCalled();
    runFrame();
    expect(bridge.syncStages).toHaveBeenCalledTimes(1);

    register(3);
    runFrame();
    expect(bridge.syncStages).toHaveBeenCalledTimes(2);

    register(5);
    runFrame();
    expect(bridge.syncStages).toHaveBeenCalledTimes(3);
    expect(bridge.render).toHaveBeenCalledTimes(3);
  });

  it("posts no stages when the registry changes but its stage objects are the same", () => {
    const bridge = fakeBridge();
    const a = stage("acme.a");
    const b = stage("acme.b");
    useRegistry.setState({ processingStages: { "acme.a": a, "acme.b": b } });
    wireBridge(bridge);
    useRegistry.setState((s) => ({ processingStages: { ...s.processingStages } }));
    runFrame();
    expect(bridge.syncStages).not.toHaveBeenCalled();
    expect(bridge.render).not.toHaveBeenCalled();
  });

  it("posts the stages when one is replaced, removed, added or reordered", () => {
    const bridge = fakeBridge();
    const a = stage("acme.a");
    const b = stage("acme.b");
    useRegistry.setState({ processingStages: { "acme.a": a, "acme.b": b } });
    wireBridge(bridge);
    const changes: Record<string, RegisteredProcessingStage>[] = [
      { "acme.a": stage("acme.a"), "acme.b": b },
      { "acme.a": a },
      { "acme.a": a, "acme.b": b, "acme.c": stage("acme.c") },
      { "acme.b": b, "acme.a": a },
    ];
    let expected = 0;
    for (const next of changes) {
      useRegistry.setState({ processingStages: next });
      runFrame();
      expect(bridge.syncStages).toHaveBeenCalledTimes(++expected);
      useRegistry.setState({ processingStages: { "acme.a": a, "acme.b": b } });
      runFrame();
      expect(bridge.syncStages).toHaveBeenCalledTimes(++expected);
    }
  });

  it("posts the stages without an animation frame once the fallback timeout runs", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const bridge = fakeBridge();
      wireBridge(bridge);
      useRegistry.setState({ processingStages: { "acme.a": stage("acme.a") } });
      vi.advanceTimersByTime(49);
      expect(bridge.syncStages).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(bridge.syncStages).toHaveBeenCalledTimes(1);
      expect(bridge.render).toHaveBeenCalledTimes(1);
      runFrame();
      expect(bridge.syncStages).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("posts nothing on a frame where no stage changed", () => {
    const bridge = fakeBridge();
    wireBridge(bridge);
    runFrame();
    expect(bridge.syncStages).not.toHaveBeenCalled();
  });
});
