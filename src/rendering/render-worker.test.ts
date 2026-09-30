// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// After a first init fails (e.g. Chromium refusing WebGL2 right after a GPU
// reset) the bridge retries. Messages that arrive while the develop renderer
// is null only update the worker's latest* module state; the retried
// renderer must be seeded from that state, the same way ensureThumbRenderer
// seeds the thumb renderer — otherwise recovery silently drops back to the
// built-in pipeline with no extension stages.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessingStageContribution, StageTextureData } from "@/extensions/types";
import type { ResolvedPipeline } from "@/extensions/pipelines";
import type { WorkerRequest, WorkerResponse } from "./render-worker";

const { FakeRenderer } = vi.hoisted(() => {
  class FakeRenderer {
    static instances: FakeRenderer[] = [];
    static throwOnConstruct = false;

    opts: unknown;
    colorBufferFloat = true;
    cacheBudget: number | null = null;
    contributedParams: Record<string, unknown> | null = null;
    stageTextures: Record<string, unknown> | null = null;

    constructor(_canvas: unknown, opts: unknown) {
      if (FakeRenderer.throwOnConstruct) {
        throw new Error("WebGL2 not supported");
      }
      this.opts = opts;
      FakeRenderer.instances.push(this);
    }

    setCacheBudget(bytes: number) {
      this.cacheBudget = bytes;
    }

    setContributedParams(bag: Record<string, unknown>) {
      this.contributedParams = bag;
    }

    setStageTextures(bag: Record<string, StageTextureData>) {
      this.stageTextures = bag;
    }

    setActivePipeline(_pipeline: ResolvedPipeline) {}

    setStages(_stages: ProcessingStageContribution[]) {}
  }
  return { FakeRenderer };
});

vi.mock("./webgl/renderer", () => ({ WebGLRenderer: FakeRenderer }));

class FakeOffscreenCanvas {
  width: number;
  height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
}

interface SelfStub {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (msg: WorkerResponse) => void;
}

describe("render-worker init recovery", () => {
  let posted: WorkerResponse[];
  let selfStub: SelfStub;

  beforeEach(async () => {
    vi.resetModules();
    FakeRenderer.instances = [];
    FakeRenderer.throwOnConstruct = false;
    posted = [];
    selfStub = {
      onmessage: null,
      postMessage: (msg) => posted.push(msg),
    };
    vi.stubGlobal("self", selfStub);
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    await import("./render-worker");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function send(msg: WorkerRequest) {
    selfStub.onmessage!({ data: msg } as MessageEvent<WorkerRequest>);
  }

  it("seeds a retried renderer from the latest pipeline, stages, bag, textures and cache budget", () => {
    // First init fails, as it would right after a GPU reset.
    FakeRenderer.throwOnConstruct = true;
    send({ cmd: "init", width: 64, height: 64, highBitDepth: false });
    expect(posted.at(-1)).toMatchObject({ type: "initError" });
    expect(FakeRenderer.instances).toHaveLength(0);

    // Messages arrive while renderer is null — they only update latest* state.
    const pipeline: ResolvedPipeline = {
      id: "ext.custom",
      glsl: "vec3 pipelineToDisplay(vec3 c) { return c; }",
      skipBaseCurve: false,
      sig: "ext.custom\nglsl",
    };
    const stages: ProcessingStageContribution[] = [
      { id: "ext.stage", name: "Stage", phase: "tone-map", glsl: "color *= 1.0;", uniforms: [] },
    ];
    const textures: Record<string, StageTextureData> = {
      "ext.stage.lut": { data: new Uint8Array(4), width: 1, height: 1, format: "rgba8", version: 1 },
    };
    send({ cmd: "setPipeline", pipeline });
    send({ cmd: "setStages", stages });
    send({ cmd: "setContributedParams", bag: { "ext.stage.amount": 0.5 } });
    send({ cmd: "setStageTextures", bag: textures });
    send({ cmd: "setCacheBudget", bytes: 1_000_000 });

    FakeRenderer.throwOnConstruct = false;
    send({ cmd: "init", width: 64, height: 64, highBitDepth: false });

    expect(FakeRenderer.instances).toHaveLength(1);
    const created = FakeRenderer.instances[0];
    expect(created.opts).toMatchObject({ pipeline, stages });
    expect(created.contributedParams).toEqual({ "ext.stage.amount": 0.5 });
    expect(created.stageTextures).toEqual(textures);
    expect(created.cacheBudget).toBe(1_000_000);
    expect(posted.at(-1)).toMatchObject({ type: "ready" });
  });
});
