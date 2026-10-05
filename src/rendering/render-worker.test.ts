// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// After a first init fails (e.g. Chromium refusing WebGL2 right after a GPU
// reset) the bridge retries. Messages that arrive while the develop renderer
// is null only update the worker's latest* module state; the retried
// renderer must be seeded from that state, the same way ensureThumbRenderer
// seeds the thumb renderer — otherwise recovery silently drops back to the
// built-in pipeline with no extension stages, and to a photo with no params.
//
// A renderer builds its develop program on the first frame, so the worker builds
// it when it creates a renderer. A stock program the driver can't build (so
// nothing can be) fails the init, answered with initError for the bridge to retry
// and report, or the thumbnail request. Stages or a display transform that can't
// be built are not a renderer that can't: that is logged once and the renderer
// stays, so frames fail until the stages or transform change, and then recover.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CURRENT_PROCESS_VERSION, DEFAULT_DEVELOP_PARAMS } from "@/catalog/types";
import type { ProcessingStageContribution, StageTextureData } from "@/extensions/types";
import { BUILTIN_RESOLVED, type ResolvedPipeline } from "@/extensions/pipelines";
import type { WorkerRequest, WorkerResponse } from "./render-worker";

/** What the worker hands a renderer it has just made, from the state it holds. */
type SeedingMethod = "setCacheBudget" | "setContributedParams" | "setStageTextures" | "setParams";

const { FakeRenderer } = vi.hoisted(() => {
  class FakeRenderer {
    static instances: FakeRenderer[] = [];
    static throwOnConstruct = false;
    /** Thrown by prepareProgram, as stages or a transform that fail to build do. */
    static prepareError: Error | null = null;
    /** Thrown by prepareStockProgram, as a stock program the driver can't build. */
    static stockError: Error | null = null;
    /** Thrown by render, as a frame that can't build its program does. */
    static renderError: Error | null = null;
    /** Thrown by the method of that name, as a renderer that can't take what it is handed does. */
    static failing: Partial<Record<SeedingMethod, Error>> = {};

    opts: unknown;
    colorBufferFloat = true;
    cacheBudget: number | null = null;
    contributedParams: Record<string, unknown> | null = null;
    /** The argument of each setContributedParams call. */
    contributedSeen: Record<string, unknown>[] = [];
    stageTextures: Record<string, unknown> | null = null;
    /** capFloat16 of each setImage call. */
    capFloat16: boolean[] = [];
    /** The argument of each setParams call. */
    paramsSeen: unknown[] = [];
    pipeline: ResolvedPipeline | null = null;
    /** Each prepareProgram call: its version, and the pipeline the renderer held. */
    prepared: { version: number; pipeline: ResolvedPipeline | null }[] = [];
    /** The version of each prepareStockProgram call. */
    stockPrepared: number[] = [];
    disposed = false;

    constructor(_canvas: unknown, opts: unknown) {
      if (FakeRenderer.throwOnConstruct) {
        throw new Error("WebGL2 not supported");
      }
      this.opts = opts;
      FakeRenderer.instances.push(this);
    }

    prepareProgram(version: number) {
      this.prepared.push({ version, pipeline: this.pipeline });
      if (FakeRenderer.prepareError) throw FakeRenderer.prepareError;
    }

    prepareStockProgram(version: number) {
      this.stockPrepared.push(version);
      if (FakeRenderer.stockError) throw FakeRenderer.stockError;
    }

    dispose() {
      this.disposed = true;
    }

    private failIfAsked(method: SeedingMethod) {
      const error = FakeRenderer.failing[method];
      if (error) throw error;
    }

    setCacheBudget(bytes: number) {
      this.failIfAsked("setCacheBudget");
      this.cacheBudget = bytes;
    }

    setContributedParams(bag: Record<string, unknown>) {
      this.failIfAsked("setContributedParams");
      this.contributedParams = bag;
      this.contributedSeen.push(bag);
    }

    setStageTextures(bag: Record<string, StageTextureData>) {
      this.failIfAsked("setStageTextures");
      this.stageTextures = bag;
    }

    setActivePipeline(pipeline: ResolvedPipeline) {
      this.pipeline = pipeline;
    }

    setStages(_stages: ProcessingStageContribution[]) {}

    setImage(
      _image: unknown,
      _maxEdge?: number,
      _isFallbackPreview?: boolean,
      _baseCurveForBitmap?: boolean,
      capFloat16 = false,
    ) {
      this.capFloat16.push(capFloat16);
    }

    setAsShotTemperature(_kelvin: number) {}

    bindSource(_key: string, _maxEdge?: number) {
      return false;
    }

    /** The key of each uploadSource call. */
    uploads: string[] = [];

    uploadSource(key: string, ..._rest: unknown[]) {
      this.uploads.push(key);
    }

    setParams(params: unknown) {
      this.failIfAsked("setParams");
      this.paramsSeen.push(params);
    }

    render() {
      if (FakeRenderer.renderError) throw FakeRenderer.renderError;
    }
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

  convertToBlob(): Promise<Blob> {
    return Promise.resolve(new Blob());
  }

  transferToImageBitmap(): ImageBitmap {
    return { width: this.width, height: this.height, close() {} };
  }
}

interface SelfStub {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (msg: WorkerResponse) => void;
}

let posted: WorkerResponse[];
let selfStub: SelfStub;

beforeEach(async () => {
  vi.resetModules();
  FakeRenderer.instances = [];
  FakeRenderer.throwOnConstruct = false;
  FakeRenderer.prepareError = null;
  FakeRenderer.stockError = null;
  FakeRenderer.renderError = null;
  FakeRenderer.failing = {};
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
  vi.restoreAllMocks();
});

/** A display transform an extension registered. */
const PICK: ResolvedPipeline = {
  id: "ext.pick",
  glsl: "vec3 pipelineToDisplay(vec3 c) { return c; }",
  skipBaseCurve: false,
  skipToneShoulder: false,
  sig: "ext.pick",
};

/** A driver that can't build the stock program can't build anything on it either. */
function driverFails(error: Error) {
  FakeRenderer.prepareError = error;
  FakeRenderer.stockError = error;
}

function send(msg: WorkerRequest) {
  selfStub.onmessage!({ data: msg } as MessageEvent<WorkerRequest>);
}

describe("render-worker init recovery", () => {
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
      skipToneShoulder: false,
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

  // The Develop view posts the photo's params as soon as it mounts, which can
  // be while the first init is still failing; a retry posts init alone.
  it("hands a retried renderer the params that arrived while init was failing", () => {
    FakeRenderer.throwOnConstruct = true;
    send({ cmd: "init", width: 64, height: 64, highBitDepth: false });
    expect(FakeRenderer.instances).toHaveLength(0);

    const earlier = { ...DEFAULT_DEVELOP_PARAMS, exposure: 0.5 };
    const latest = { ...DEFAULT_DEVELOP_PARAMS, exposure: 1 };
    send({ cmd: "setParams", params: earlier });
    send({ cmd: "setParams", params: latest });

    FakeRenderer.throwOnConstruct = false;
    send({ cmd: "init", width: 64, height: 64, highBitDepth: false });

    expect(FakeRenderer.instances).toHaveLength(1);
    expect(FakeRenderer.instances[0].paramsSeen).toEqual([latest]);
    expect(FakeRenderer.instances[0].paramsSeen[0]).toBe(latest);
    expect(posted.at(-1)).toMatchObject({ type: "ready" });
  });

  it("leaves a renderer that was sent no params without any", () => {
    send({ cmd: "init", width: 64, height: 64, highBitDepth: false });
    expect(FakeRenderer.instances[0].paramsSeen).toEqual([]);
  });

  it("applies params sent after the renderer exists straight to it", () => {
    send({ cmd: "init", width: 64, height: 64, highBitDepth: false });
    const params = { ...DEFAULT_DEVELOP_PARAMS, exposure: 2 };
    send({ cmd: "setParams", params });
    expect(FakeRenderer.instances[0].paramsSeen).toEqual([params]);
  });
});

// Nothing but `ready` tells the bridge an init finished, so a renderer that throws as
// the worker hands it what arrived before it existed must still be answered. The throw
// is logged and the renderer kept: the bridge sends what it needs again after init.
describe("render-worker init seeding", () => {
  const INIT: WorkerRequest = { cmd: "init", width: 64, height: 64, highBitDepth: false };
  const SEEDING: SeedingMethod[] = [
    "setCacheBudget",
    "setContributedParams",
    "setStageTextures",
    "setParams",
  ];

  /** Gives every seeding method something to take. */
  function arriveBeforeInit() {
    send({ cmd: "setCacheBudget", bytes: 1_000_000 });
    send({ cmd: "setContributedParams", bag: { "ext.stage.amount": 0.5 } });
    send({ cmd: "setStageTextures", bag: {} });
    send({ cmd: "setParams", params: DEFAULT_DEVELOP_PARAMS });
  }

  /** The seeding methods whose call reached the renderer: one that throws records nothing. */
  function landed(created: InstanceType<typeof FakeRenderer>): SeedingMethod[] {
    const reached: Record<SeedingMethod, boolean> = {
      setCacheBudget: created.cacheBudget !== null,
      setContributedParams: created.contributedParams !== null,
      setStageTextures: created.stageTextures !== null,
      setParams: created.paramsSeen.length > 0,
    };
    return SEEDING.filter((method) => reached[method]);
  }

  it.each(SEEDING)("answers ready, and logs it, when %s throws", (method) => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    arriveBeforeInit();
    FakeRenderer.failing[method] = new Error(`${method} failed`);

    send(INIT);

    expect(posted).toEqual([{ type: "ready", pipelineFloat: true }]);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0].join(" ")).toContain(`${method} failed`);
  });

  // The bridge sends params and the bag again after `ready` but never stage textures, so a
  // throw must not skip the steps behind it: a stage that reads a LUT would draw black
  // until some texture changed.
  it.each(SEEDING)("still hands the renderer every other step when %s throws", (method) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    arriveBeforeInit();
    FakeRenderer.failing[method] = new Error(`${method} failed`);

    send(INIT);

    expect(landed(FakeRenderer.instances[0])).toEqual(SEEDING.filter((step) => step !== method));
    expect(posted).toEqual([{ type: "ready", pipelineFloat: true }]);
  });

  it("hands over the stage textures and params that follow a throwing setContributedParams", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const textures: Record<string, StageTextureData> = {
      "ext.stage.lut": { data: new Uint8Array(4), width: 1, height: 1, format: "rgba8", version: 1 },
    };
    const params = { ...DEFAULT_DEVELOP_PARAMS, exposure: 1 };
    send({ cmd: "setContributedParams", bag: { "ext.stage.amount": 0.5 } });
    send({ cmd: "setStageTextures", bag: textures });
    send({ cmd: "setParams", params });
    FakeRenderer.failing.setContributedParams = new Error("setContributedParams failed");

    send(INIT);

    const [created] = FakeRenderer.instances;
    expect(created.stageTextures).toBe(textures);
    expect(created.paramsSeen).toEqual([params]);
    expect(created.paramsSeen[0]).toBe(params);
    expect(posted).toEqual([{ type: "ready", pipelineFloat: true }]);
  });

  it("logs each step that throws, once, and answers ready once", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    arriveBeforeInit();
    FakeRenderer.failing.setContributedParams = new Error("setContributedParams failed");
    FakeRenderer.failing.setStageTextures = new Error("setStageTextures failed");

    send(INIT);

    expect(logged).toHaveBeenCalledTimes(2);
    expect(logged.mock.calls[0].join(" ")).toContain("setContributedParams failed");
    expect(logged.mock.calls[1].join(" ")).toContain("setStageTextures failed");
    expect(landed(FakeRenderer.instances[0])).toEqual(["setCacheBudget", "setParams"]);
    expect(posted).toEqual([{ type: "ready", pipelineFloat: true }]);
  });

  it("keeps the renderer, which takes frames once it can", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    arriveBeforeInit();
    FakeRenderer.failing.setParams = new Error("setParams failed");
    send(INIT);
    expect(FakeRenderer.instances[0].disposed).toBe(false);

    FakeRenderer.failing = {};
    send({ cmd: "render" });
    expect(posted.at(-1)).toMatchObject({ type: "frame" });
  });

  it("logs nothing when seeding goes through", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    arriveBeforeInit();
    send(INIT);
    expect(posted).toEqual([{ type: "ready", pipelineFloat: true }]);
    expect(logged).not.toHaveBeenCalled();
  });
});

describe("render-worker develop program warm-up", () => {
  const INIT: WorkerRequest = { cmd: "init", width: 64, height: 64, highBitDepth: false };

  it("builds the program at the current version while no params have arrived", () => {
    send(INIT);
    const versions = FakeRenderer.instances[0].prepared.map((call) => call.version);
    expect(versions).toEqual([CURRENT_PROCESS_VERSION]);
    expect(posted.at(-1)).toMatchObject({ type: "ready" });
  });

  it("builds it at the version of the params that arrived before init", () => {
    send({ cmd: "setParams", params: { ...DEFAULT_DEVELOP_PARAMS, processVersion: 1 } });
    send(INIT);
    expect(FakeRenderer.instances[0].prepared.map((call) => call.version)).toEqual([1]);
  });

  it("does not build the stock program when the program builds", () => {
    send(INIT);
    expect(FakeRenderer.instances[0].stockPrepared).toEqual([]);
  });

  it("answers initError, not ready, when the stock program can't be built, and frees it", () => {
    driverFails(new Error("Shader compile failed: boom"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    send(INIT);
    expect(posted.map((msg) => msg.type)).toEqual(["initError"]);
    expect(posted[0]).toMatchObject({ message: "Shader compile failed: boom" });
    expect(FakeRenderer.instances[0].disposed).toBe(true);
    expect(logged).not.toHaveBeenCalled();

    // Nothing is left behind to take frames.
    send({ cmd: "render" });
    expect(posted.map((msg) => msg.type)).toEqual(["initError"]);
  });

  it("reports the stock program's own error when both programs fail", () => {
    FakeRenderer.prepareError = new Error("the stages");
    FakeRenderer.stockError = new Error("the driver");
    send(INIT);
    expect(posted).toEqual([{ type: "initError", message: "the driver" }]);
  });

  it("builds a fresh renderer when the bridge retries after a driver failure", () => {
    driverFails(new Error("boom"));
    send(INIT);
    FakeRenderer.prepareError = null;
    FakeRenderer.stockError = null;
    send(INIT);
    expect(FakeRenderer.instances).toHaveLength(2);
    expect(FakeRenderer.instances[1].disposed).toBe(false);
    expect(posted.map((msg) => msg.type)).toEqual(["initError", "ready"]);
  });

  // Stages or a transform that can't be built fail frames, not the renderer: the
  // stock program is built to tell the two apart, the error is logged once, and the
  // renderer stays, so it can recover when the stages or transform change.
  describe("when only the stages or transform can't be built", () => {
    it("answers ready, with the renderer kept, and logs the error once", () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      FakeRenderer.prepareError = new Error("Shader compile failed: neverDeclared");
      send(INIT);
      expect(posted.map((msg) => msg.type)).toEqual(["ready"]);
      expect(FakeRenderer.instances).toHaveLength(1);
      expect(FakeRenderer.instances[0].disposed).toBe(false);
      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged.mock.calls[0].join(" ")).toContain("Shader compile failed: neverDeclared");
    });

    it("builds the stock program at the version the program was built for", () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      FakeRenderer.prepareError = new Error("stages");
      send(INIT);
      expect(FakeRenderer.instances[0].stockPrepared).toEqual([CURRENT_PROCESS_VERSION]);

      send({ cmd: "setParams", params: { ...DEFAULT_DEVELOP_PARAMS, processVersion: 1 } });
      send(INIT);
      expect(FakeRenderer.instances[1].prepared.map((call) => call.version)).toEqual([1]);
      expect(FakeRenderer.instances[1].stockPrepared).toEqual([1]);
    });

    it("leaves the renderer to take frames, which fail until the stages change", () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      FakeRenderer.prepareError = new Error("stages");
      send(INIT);
      FakeRenderer.renderError = new Error("Shader compile failed: stages");
      send({ cmd: "render" });
      expect(posted.at(-1)).toEqual({ type: "error", message: "Shader compile failed: stages" });

      FakeRenderer.renderError = null;
      send({ cmd: "setStages", stages: [] });
      send({ cmd: "render" });
      expect(posted.at(-1)).toMatchObject({ type: "frame" });
    });
  });

  // The bridge posts the current stages and pipeline just ahead of every init, so
  // the renderer is built with them and the warm-up builds the program the first
  // frame needs. Before a renderer exists they are only stored, and answer nothing.
  describe("after the stages and pipeline are posted ahead of init", () => {
    const stage = (id: string): ProcessingStageContribution => ({
      id,
      name: id,
      phase: "effects",
      glsl: "c = c;",
      uniforms: [],
    });
    it("builds the first renderer, and its program, with them", () => {
      send({ cmd: "setPipeline", pipeline: PICK });
      send({ cmd: "setStages", stages: [stage("ext.first")] });
      expect(posted).toEqual([]);
      expect(FakeRenderer.instances).toHaveLength(0);

      send(INIT);
      const [created] = FakeRenderer.instances;
      expect(created.opts).toMatchObject({ pipeline: PICK, stages: [stage("ext.first")] });
      expect(created.prepared.map((call) => call.version)).toEqual([CURRENT_PROCESS_VERSION]);
      expect(posted.map((msg) => msg.type)).toEqual(["ready"]);
    });

    it("builds a retried renderer with the ones posted ahead of the retry", () => {
      send({ cmd: "setStages", stages: [stage("ext.first")] });
      driverFails(new Error("boom"));
      send(INIT);
      expect(FakeRenderer.instances[0].opts).toMatchObject({ stages: [stage("ext.first")] });
      expect(posted.at(-1)).toMatchObject({ type: "initError" });

      FakeRenderer.prepareError = null;
      FakeRenderer.stockError = null;
      send({ cmd: "setPipeline", pipeline: PICK });
      send({ cmd: "setStages", stages: [stage("ext.first"), stage("ext.second")] });
      send(INIT);
      const retried = FakeRenderer.instances[1];
      expect(retried.opts).toMatchObject({
        pipeline: PICK,
        stages: [stage("ext.first"), stage("ext.second")],
      });
      expect(retried.prepared).toHaveLength(1);
      expect(posted.map((msg) => msg.type)).toEqual(["initError", "ready"]);
    });
  });
});

describe("render-worker frames", () => {
  it("answers a render that throws with a generic error and posts no frame", () => {
    send({ cmd: "init", width: 64, height: 64, highBitDepth: false });
    FakeRenderer.renderError = new Error("Shader compile failed: boom");
    send({ cmd: "render" });
    expect(posted.at(-1)).toEqual({ type: "error", message: "Shader compile failed: boom" });
    expect(posted.some((msg) => msg.type === "frame")).toBe(false);
  });
});

const CACHED = {
  kind: "float16" as const,
  data: new Uint16Array(4 * 4),
  width: 2,
  height: 2,
};

function thumbnail(over: Partial<Extract<WorkerRequest, { cmd: "renderThumbnail" }>> = {}) {
  const request: WorkerRequest = {
    cmd: "renderThumbnail",
    requestId: "t1",
    image: CACHED,
    params: DEFAULT_DEVELOP_PARAMS,
    asShotTemperature: 5500,
    maxEdge: 256,
    pipeline: BUILTIN_RESOLVED,
    ...over,
  };
  return request;
}

// The bridge posts the extension param bag whole once, then only what changed. A patch
// is merged into the bag the worker holds as a new object, and what it doesn't name
// stays the very objects both renderers already saw: the develop renderer bakes painted
// coverage again unless the dabs are the array it baked last.
describe("render-worker contributed params", () => {
  const INIT: WorkerRequest = { cmd: "init", width: 64, height: 64, highBitDepth: false };
  const dabs = (x: number) => [{ x, y: 0.5, radius: 0.1, feather: 0.5 }];
  const whole = (bag: Record<string, unknown>) => send({ cmd: "setContributedParams", bag });
  const patch = (set: Record<string, unknown>, remove: string[] = []) =>
    send({ cmd: "patchContributedParams", set, remove });
  const develop = () => FakeRenderer.instances[0];

  it("merges a patch into the bag as a new object, keeping the values it doesn't name", () => {
    send(INIT);
    const painted = dabs(0.2);
    const bag = { "a.gain": 1, "a.cov": painted, "b.take": 0 };
    whole(bag);
    patch({ "a.gain": 2 });

    const held = develop().contributedParams;
    expect(held).toEqual({ "a.gain": 2, "a.cov": painted, "b.take": 0 });
    expect(held?.["a.cov"]).toBe(painted);
    expect(held).not.toBe(bag);
    expect(bag).toEqual({ "a.gain": 1, "a.cov": painted, "b.take": 0 });
  });

  it("applies removals, and sets keys the bag didn't have", () => {
    send(INIT);
    whole({ "a.gain": 1, "a.cov": dabs(0.2), "b.take": 0 });
    patch({ "c.mix": 3 }, ["a.cov", "b.take"]);
    expect(develop().contributedParams).toEqual({ "a.gain": 1, "c.mix": 3 });
    expect(Object.keys(develop().contributedParams ?? {})).toEqual(["a.gain", "c.mix"]);
  });

  it("merges each patch onto the bag the last one made", () => {
    send(INIT);
    whole({ "a.gain": 1, "b.take": 0 });
    patch({ "a.gain": 2 });
    patch({ "b.take": 1 });
    patch({ "a.gain": 3 }, ["b.take"]);
    expect(develop().contributedParams).toEqual({ "a.gain": 3 });
  });

  it("builds on an empty bag when no whole bag came first", () => {
    send(INIT);
    patch({ "a.gain": 2 });
    expect(develop().contributedParams).toEqual({ "a.gain": 2 });
  });

  it("holds exactly a whole bag that arrives after patches", () => {
    send(INIT);
    whole({ "a.gain": 1, "b.take": 0 });
    patch({ "c.mix": 3 });
    const replacement = { "a.gain": 4 };
    whole(replacement);
    expect(develop().contributedParams).toBe(replacement);
    patch({ "b.take": 1 });
    expect(develop().contributedParams).toEqual({ "a.gain": 4, "b.take": 1 });
  });

  it("answers a patch with nothing", () => {
    send(INIT);
    const before = posted.length;
    patch({ "a.gain": 2 });
    expect(posted).toHaveLength(before);
  });

  it("hands the merged bag to the develop and the thumbnail renderer alike", () => {
    send(INIT);
    send({ cmd: "uploadSource", target: "thumb", key: "k", image: CACHED });
    whole({ "a.gain": 1, "a.cov": dabs(0.2) });
    patch({ "a.gain": 2 });
    const [develop, thumb] = FakeRenderer.instances;
    expect(develop.contributedParams).toEqual({ "a.gain": 2, "a.cov": dabs(0.2) });
    expect(thumb.contributedParams).toBe(develop.contributedParams);
  });

  it("seeds a renderer made after the patches with the merged bag", () => {
    send(INIT);
    whole({ "a.gain": 1, "a.cov": dabs(0.2) });
    patch({ "a.gain": 2 });
    send(INIT);
    const [first, second] = FakeRenderer.instances;
    expect(second.contributedParams).toEqual({ "a.gain": 2, "a.cov": dabs(0.2) });
    expect(second.contributedParams).toBe(first.contributedParams);
  });

  it("merges a patch that arrives while no renderer exists, for the retry's renderer", () => {
    FakeRenderer.throwOnConstruct = true;
    send(INIT);
    expect(FakeRenderer.instances).toHaveLength(0);
    whole({ "a.gain": 1, "b.take": 0 });
    patch({ "a.gain": 2 }, ["b.take"]);
    FakeRenderer.throwOnConstruct = false;
    send(INIT);
    expect(develop().contributedParams).toEqual({ "a.gain": 2 });
  });

  describe("with a thumbnail's own bag", () => {
    it("restores the merged bag after it, not the bag the patch replaced", () => {
      send(INIT);
      const base = { "a.gain": 1, "a.cov": dabs(0.2) };
      whole(base);
      const own = { "a.gain": 9 };
      send(thumbnail({ contributedParams: own }));
      patch({ "a.gain": 2 });
      const ownLater = { "a.gain": 7 };
      send(thumbnail({ requestId: "t2", contributedParams: ownLater }));

      const [live, thumb] = FakeRenderer.instances;
      const merged = live.contributedParams;
      expect(merged).toEqual({ "a.gain": 2, "a.cov": dabs(0.2) });
      expect(thumb.contributedSeen).toEqual([base, own, base, merged, ownLater, merged]);
      expect(thumb.contributedSeen[2]).toBe(base);
      expect(thumb.contributedSeen[5]).toBe(merged);
      expect(thumb.contributedParams).toBe(merged);
      expect(posted.filter((msg) => msg.type === "thumbnailError")).toEqual([]);
    });

    it("restores the merged bag even when the render throws", () => {
      send(INIT);
      whole({ "a.gain": 1 });
      patch({ "a.gain": 2 });
      FakeRenderer.renderError = new Error("Shader compile failed: boom");
      send(thumbnail({ contributedParams: { "a.gain": 9 } }));
      FakeRenderer.renderError = null;
      expect(posted.at(-1)).toMatchObject({ type: "thumbnailError" });
      expect(FakeRenderer.instances[1].contributedParams).toBe(develop().contributedParams);
      expect(FakeRenderer.instances[1].contributedParams).toEqual({ "a.gain": 2 });
    });
  });
});

// A cached float16 source otherwise uploads at its stored size; the thumb
// renderer only ever draws at the thumbnail edge, so it caps the upload there,
// as a thumb-targeted uploadSource already does.
describe("render-worker thumbnails", () => {
  it("caps a cached float16 source sent with the render", () => {
    send(thumbnail());
    expect(FakeRenderer.instances[0].capFloat16).toEqual([true]);
  });

  it("builds its program for the requested photo's version and display transform", () => {
    send(thumbnail({ params: { ...DEFAULT_DEVELOP_PARAMS, processVersion: 1 }, pipeline: PICK }));
    expect(FakeRenderer.instances[0].prepared).toEqual([{ version: 1, pipeline: PICK }]);
  });

  it("builds it the same way when the render starts from a resident source", () => {
    send({
      cmd: "renderThumbnailFromSource",
      requestId: "t1",
      key: "photo-1",
      params: { ...DEFAULT_DEVELOP_PARAMS, processVersion: 1 },
      asShotTemperature: 5500,
      maxEdge: 256,
      pipeline: PICK,
    });
    expect(FakeRenderer.instances[0].prepared).toEqual([{ version: 1, pipeline: PICK }]);
    expect(posted.at(-1)).toMatchObject({ type: "thumbnailMiss", requestId: "t1" });
  });

  it("answers thumbnailError and keeps no renderer when the stock program can't be built", () => {
    driverFails(new Error("boom"));
    send(thumbnail());
    expect(posted.at(-1)).toMatchObject({
      type: "thumbnailError",
      requestId: "t1",
      message: "boom",
    });
    expect(FakeRenderer.instances[0].disposed).toBe(true);

    FakeRenderer.prepareError = null;
    FakeRenderer.stockError = null;
    send(thumbnail({ requestId: "t2" }));
    expect(FakeRenderer.instances).toHaveLength(2);
    expect(FakeRenderer.instances[1].disposed).toBe(false);
    expect(posted.filter((msg) => msg.type === "thumbnailError")).toHaveLength(1);
  });

  // The stock program builds, so the renderer is sound: it is kept, the error is
  // logged once, and each request fails at its own frame (as it must, the stages
  // being what they are) without a new renderer or another log, until they change.
  describe("when only the stages or transform can't be built", () => {
    it("keeps the renderer, logs once, and fails each request at its frame", () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      FakeRenderer.prepareError = new Error("Shader compile failed: stages");
      FakeRenderer.renderError = new Error("Shader compile failed: stages");
      send(thumbnail({ params: { ...DEFAULT_DEVELOP_PARAMS, processVersion: 1 } }));
      send(thumbnail({ requestId: "t2" }));

      expect(FakeRenderer.instances).toHaveLength(1);
      expect(FakeRenderer.instances[0].disposed).toBe(false);
      expect(FakeRenderer.instances[0].stockPrepared).toEqual([1]);
      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged.mock.calls[0].join(" ")).toContain("Shader compile failed: stages");
      expect(posted.filter((msg) => msg.type === "thumbnailError")).toEqual([
        { type: "thumbnailError", requestId: "t1", message: "Shader compile failed: stages" },
        { type: "thumbnailError", requestId: "t2", message: "Shader compile failed: stages" },
      ]);
    });
  });

  // An upload carries no params, so a renderer it creates builds the current version
  // under the stages and transform the worker holds, and classifies a failure alike.
  describe("when an upload creates the renderer", () => {
    const upload: WorkerRequest = { cmd: "uploadSource", target: "thumb", key: "k", image: CACHED };

    it("builds its program at the current version, with the stages and pipeline held", () => {
      const stages: ProcessingStageContribution[] = [
        { id: "ext.stage", name: "Stage", phase: "effects", glsl: "c = c;", uniforms: [] },
      ];
      send({ cmd: "setPipeline", pipeline: PICK });
      send({ cmd: "setStages", stages });
      send(upload);
      const [created] = FakeRenderer.instances;
      expect(created.opts).toMatchObject({ pipeline: PICK, stages });
      expect(created.prepared.map((call) => call.version)).toEqual([CURRENT_PROCESS_VERSION]);
      expect(created.uploads).toEqual(["k"]);
    });

    it("keeps the renderer, logging once, when only the stages or transform can't build", () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      FakeRenderer.prepareError = new Error("Shader compile failed: stages");
      send(upload);
      send({ ...upload, key: "k2" });
      expect(FakeRenderer.instances).toHaveLength(1);
      expect(FakeRenderer.instances[0].disposed).toBe(false);
      expect(FakeRenderer.instances[0].uploads).toEqual(["k", "k2"]);
      expect(logged).toHaveBeenCalledTimes(1);
      expect(posted).toEqual([]);
    });

    it("answers a generic error, and keeps no renderer, when the stock program can't build", () => {
      driverFails(new Error("boom"));
      send(upload);
      expect(posted).toEqual([{ type: "error", message: "boom" }]);
      expect(FakeRenderer.instances[0].disposed).toBe(true);
      expect(FakeRenderer.instances[0].uploads).toEqual([]);

      FakeRenderer.prepareError = null;
      FakeRenderer.stockError = null;
      send(upload);
      expect(FakeRenderer.instances).toHaveLength(2);
      expect(FakeRenderer.instances[1].uploads).toEqual(["k"]);
    });
  });
});
