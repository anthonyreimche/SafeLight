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
import {
  CURRENT_PROCESS_VERSION,
  DEFAULT_DEVELOP_PARAMS,
  defaultMaskAdjustments,
  type DevelopParams,
  type Mask,
  type RetouchSpot,
} from "@/catalog/types";
import type { ProcessingStageContribution, StageSpace, StageTextureData } from "@/extensions/types";
import { BUILTIN_RESOLVED, type ResolvedPipeline } from "@/extensions/pipelines";
import type { WorkerRequest, WorkerResponse } from "./render-worker";
import { LIVE_MASK_COPY_PREPASSES } from "./webgl/mask-stage-instances";
import type { ProbePoint } from "./webgl/renderer";
import type { MonitorTransform } from "./display-profile";
import type { ColorSpaceId, DisplaySpace } from "./color-space";
import type { CapturePoint, FloatFrame } from "./float-frame";
import { decodePerceptual, toStageSpace } from "./stage-space";

/** What the worker hands a renderer it has just made, from the state it holds. */
type SeedingMethod = "setCacheBudget" | "setContributedParams" | "setStageTextures" | "setParams";
/** Renderer methods a test can make throw. */
type FailingMethod = SeedingMethod | "setImage" | "uploadSource" | "bindSource";

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
    /** Thrown by computeHistogram, as a readback that fails does. */
    static histogramError: Error | null = null;
    /** What probe answers, and what it throws, as a probe that fails does. */
    static probed: [number, number, number] | null = null;
    static probeError: Error | null = null;
    /** What readFloatFrame answers (null: no float targets), and what it throws. */
    static floatFrame: { data: Float32Array; width: number; height: number } | null = null;
    static floatError: Error | null = null;
    /** Thrown by the method of that name, as a renderer that can't take what it is handed does. */
    static failing: Partial<Record<FailingMethod, Error>> = {};

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
    paramsSeen: DevelopParams[] = [];
    pipeline: ResolvedPipeline | null = null;
    /** Each prepareProgram call: its version, and the pipeline the renderer held. */
    prepared: { version: number; pipeline: ResolvedPipeline | null }[] = [];
    /** The version of each prepareStockProgram call. */
    stockPrepared: number[] = [];
    /** The display transform it holds, and the one each render drew with. */
    monitorTransform: MonitorTransform | null = null;
    renderedWith: (MonitorTransform | null)[] = [];
    /** The display space it holds, the argument of each setDisplaySpace call, and the
     *  space each render drew in. */
    displaySpace: DisplaySpace = "srgb";
    displaySpaceSeen: DisplaySpace[] = [];
    renderedIn: DisplaySpace[] = [];
    /** The proof space it holds, and the one each render drew with. */
    proofSpace: ColorSpaceId | null = null;
    renderedProof: (ColorSpaceId | null)[] = [];
    /** What each render drew with: the last params and bag set, and whether
     *  the view's overlays (clipping warning, mask tint, sharpening preview) were on. */
    drawn: { params: DevelopParams | undefined; bag: Record<string, unknown> | null; overlays: boolean }[] = [];
    /** Each render and readback, in order. */
    calls: ("render" | "computeHistogram" | "readDownscaledPixels" | "probe" | "readFloatFrame")[] = [];
    /** What each readFloatFrame drew: its point and long-edge cap, and the
     *  params, bag, pipeline and screen it drew with. */
    floatReads: {
      point: CapturePoint;
      maxEdge: number | undefined;
      params: DevelopParams | undefined;
      bag: Record<string, unknown> | null;
      pipeline: ResolvedPipeline | null;
      screen: [MonitorTransform | null, DisplaySpace, ColorSpaceId | null];
    }[] = [];
    /** The arguments of each probe call. */
    probes: { u: number; v: number; point: ProbePoint }[] = [];
    /** The stages the last render left without a prepass unit. */
    overflowedStages: string[] = [];
    /** Whether the last render put off a mask copy's prepass. */
    prepassPending = false;
    /** The window setViewport holds, which each render draws. */
    viewport: { x: number; y: number; w: number; h: number } | null = null;
    /** The size of a frame of the whole image, which a window's frame doesn't have. */
    wholeWidth = 0;
    wholeHeight = 0;
    /** The region of the image each render draws: the crop it was handed. */
    drawnCrop = { x: 0, y: 0, width: 1, height: 1 };
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

    private failIfAsked(method: FailingMethod) {
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

    /** The size of the source it draws from: the image last set, uploaded and bound, or bound. */
    sourceWidth = 0;
    sourceHeight = 0;

    private holdSource(image: { width: number; height: number }) {
      this.sourceWidth = image.width;
      this.sourceHeight = image.height;
    }

    setImage(
      image: { width: number; height: number },
      _maxEdge?: number,
      _isFallbackPreview?: boolean,
      _baseCurveForBitmap?: boolean,
      capFloat16 = false,
    ) {
      this.failIfAsked("setImage");
      this.capFloat16.push(capFloat16);
      this.holdSource(image);
    }

    setAsShotTemperature(_kelvin: number) {}

    /** Keys bindSource finds resident. */
    static resident = new Set<string>();
    /** The size of every resident source. */
    static residentSize = { width: 0, height: 0 };

    bindSource(key: string, _maxEdge?: number) {
      this.failIfAsked("bindSource");
      const hit = FakeRenderer.resident.has(key);
      if (hit) this.holdSource(FakeRenderer.residentSize);
      return hit;
    }

    healSourceData() {
      return null;
    }

    computeHistogram(_extended?: boolean) {
      this.calls.push("computeHistogram");
      if (FakeRenderer.histogramError) throw FakeRenderer.histogramError;
      const bins = () => new Uint32Array(256);
      return { r: bins(), g: bins(), b: bins(), luma: bins() };
    }

    /** The key of each uploadSource call. */
    uploads: string[] = [];

    uploadSource(
      key: string,
      image: { width: number; height: number },
      _maxEdge?: number,
      _isFallbackPreview?: boolean,
      _baseCurveForBitmap?: boolean,
      bind = true,
    ) {
      this.failIfAsked("uploadSource");
      this.uploads.push(key);
      if (bind) this.holdSource(image);
    }

    setParams(params: DevelopParams) {
      this.failIfAsked("setParams");
      this.paramsSeen.push(params);
    }

    setMonitorTransform(transform: MonitorTransform | null) {
      this.monitorTransform = transform;
    }

    setDisplaySpace(space: DisplaySpace) {
      this.displaySpaceSeen.push(space);
      this.displaySpace = space;
    }

    setProofSpace(space: ColorSpaceId | null) {
      this.proofSpace = space;
    }

    /** No readable pixels: Upright answers with a zero correction. */
    readDownscaledPixels(_size: number) {
      this.calls.push("readDownscaledPixels");
      return null;
    }

    probe(u: number, v: number, point: ProbePoint) {
      this.calls.push("probe");
      this.probes.push({ u, v, point });
      if (FakeRenderer.probeError) throw FakeRenderer.probeError;
      return FakeRenderer.probed;
    }

    readFloatFrame(point: CapturePoint, maxEdge?: number) {
      this.calls.push("readFloatFrame");
      this.floatReads.push({
        point,
        maxEdge,
        params: this.paramsSeen.at(-1),
        bag: this.contributedParams,
        pipeline: this.pipeline,
        screen: [this.monitorTransform, this.displaySpace, this.proofSpace],
      });
      if (FakeRenderer.floatError) throw FakeRenderer.floatError;
      const read = FakeRenderer.floatFrame;
      return read && { ...read, data: read.data.slice() };
    }

    render(options?: { viewOverlays?: boolean }) {
      this.calls.push("render");
      this.renderedWith.push(this.monitorTransform);
      this.renderedIn.push(this.displaySpace);
      this.renderedProof.push(this.proofSpace);
      this.drawn.push({
        params: this.paramsSeen.at(-1),
        bag: this.contributedParams,
        overlays: options?.viewOverlays ?? true,
      });
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

  convertToBlob(options?: ImageEncodeOptions): Promise<Blob> {
    encodings.push(options);
    return encodeError ? Promise.reject(encodeError) : Promise.resolve(new Blob());
  }

  transferToImageBitmap(): ImageBitmap {
    const bitmap = {
      width: this.width,
      height: this.height,
      closed: false,
      close() {
        bitmap.closed = true;
      },
    };
    handedOut.push(bitmap);
    return bitmap;
  }
}

/** Every bitmap a canvas handed out, and whether it was closed. */
let handedOut: { closed: boolean }[];
/** The options of each convertToBlob call, in order. */
let encodings: (ImageEncodeOptions | undefined)[];
/** What convertToBlob rejects with, as an encode that fails does. */
let encodeError: Error | null;

interface SelfStub {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (msg: WorkerResponse, transfer?: Transferable[]) => void;
}

let posted: WorkerResponse[];
/** The transfer list of each posted message, empty when it had none. */
let transferred: Transferable[][];
let selfStub: SelfStub;

beforeEach(async () => {
  vi.resetModules();
  FakeRenderer.instances = [];
  FakeRenderer.throwOnConstruct = false;
  FakeRenderer.prepareError = null;
  FakeRenderer.stockError = null;
  FakeRenderer.renderError = null;
  FakeRenderer.histogramError = null;
  FakeRenderer.probed = null;
  FakeRenderer.probeError = null;
  FakeRenderer.floatFrame = null;
  FakeRenderer.floatError = null;
  FakeRenderer.failing = {};
  FakeRenderer.resident = new Set();
  FakeRenderer.residentSize = { width: 0, height: 0 };
  handedOut = [];
  encodings = [];
  encodeError = null;
  posted = [];
  transferred = [];
  selfStub = {
    onmessage: null,
    postMessage: (msg, transfer = []) => {
      posted.push(msg);
      transferred.push(transfer);
    },
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
    send({ cmd: "render", seq: 1 });
    expect(posted.at(-1)).toMatchObject({ type: "frame", seq: 1 });
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
    send({ cmd: "render", seq: 1 });
    expect(posted.map((msg) => msg.type)).toEqual(["initError", "frameSkipped"]);
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
      send({ cmd: "render", seq: 1 });
      expect(posted.at(-1)).toEqual({
        type: "renderError",
        seq: 1,
        message: "Shader compile failed: stages",
      });

      FakeRenderer.renderError = null;
      send({ cmd: "setStages", stages: [] });
      send({ cmd: "render", seq: 2 });
      expect(posted.at(-1)).toMatchObject({ type: "frame", seq: 2 });
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

// The bridge keeps one render in flight and sends the next only once that one is
// answered, so each render is answered exactly once, by its seq, whatever becomes of
// it: with its frame, with frameSkipped when there is nothing to draw it with or from,
// or with renderError when drawing it throws. Never with the generic error, which
// carries no seq and would leave the bridge waiting.
describe("render-worker frames", () => {
  const INIT: WorkerRequest = { cmd: "init", width: 64, height: 64, highBitDepth: false };

  it("answers a render with its frame, carrying its seq", () => {
    send(INIT);
    posted = [];
    send({ cmd: "render", seq: 7 });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ type: "frame", seq: 7, bitmap: handedOut[0] });
    expect(posted[0]).not.toHaveProperty("histogram");
  });

  it("names the window the render was drawn for, and none for the whole image", () => {
    send(INIT);
    posted = [];
    send({ cmd: "render", seq: 3 });
    FakeRenderer.instances[0].viewport = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
    send({ cmd: "render", seq: 4 });
    expect(posted.map((msg) => (msg.type === "frame" ? msg.roi : msg.type))).toEqual([
      null,
      { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
    ]);
  });

  // A window's frame says nothing of the whole image's shape, which the view places
  // the window by, and which a new crop changes while the view stays zoomed in.
  it("says the size a frame of the whole image would have, with a window's frame too", () => {
    send(INIT);
    const renderer = FakeRenderer.instances[0];
    renderer.wholeWidth = 4000;
    renderer.wholeHeight = 2667;
    renderer.viewport = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
    posted = [];
    send({ cmd: "render", seq: 4 });
    expect(posted).toEqual([
      expect.objectContaining({ type: "frame", seq: 4, wholeWidth: 4000, wholeHeight: 2667 }),
    ]);
  });

  // Crop mode draws the whole image in place of the crop; the crop box is drawn over
  // whichever the canvas shows, which on a slow GPU stays the one before for a while.
  it("names the region of the image the render was drawn for", () => {
    send(INIT);
    const crop = { x: -0.03, y: -0.03, width: 1.06, height: 1.06 };
    FakeRenderer.instances[0].drawnCrop = crop;
    posted = [];
    send({ cmd: "render", seq: 5 });
    expect(posted).toEqual([expect.objectContaining({ type: "frame", seq: 5, crop })]);
  });

  it("names the stages the render left without a prepass unit", () => {
    send(INIT);
    FakeRenderer.instances[0].overflowedStages = ["ext.equaliser.rings"];
    posted = [];
    send({ cmd: "render", seq: 9 });
    expect(posted).toEqual([
      expect.objectContaining({ type: "frame", seq: 9, overflowedStages: ["ext.equaliser.rings"] }),
    ]);
  });

  it("says when the render put off a mask copy's prepass, and only then", () => {
    send(INIT);
    posted = [];
    send({ cmd: "render", seq: 9 });
    FakeRenderer.instances[0].prepassPending = true;
    send({ cmd: "render", seq: 10 });
    const frames = posted.filter((m) => m.type === "frame");
    expect(frames.map((m) => "prepassPending" in m)).toEqual([false, true]);
    expect(frames[1]).toMatchObject({ prepassPending: true });
  });

  it("limits the develop renderer's mask copy prepasses per frame", () => {
    send(INIT);
    expect(FakeRenderer.instances[0].opts).toMatchObject({
      maskCopyPrepassesPerFrame: LIVE_MASK_COPY_PREPASSES,
    });
  });

  it("carries the histogram the render asked for", () => {
    send(INIT);
    posted = [];
    send({ cmd: "render", seq: 8, wantHistogram: true, wantExtended: true });
    expect(posted).toEqual([
      expect.objectContaining({ type: "frame", seq: 8, histogram: expect.any(Object) }),
    ]);
  });

  it("answers frameSkipped to a render that arrives before init", () => {
    send({ cmd: "render", seq: 1, wantHistogram: true });
    expect(posted).toEqual([{ type: "frameSkipped", seq: 1 }]);
  });

  it("answers frameSkipped while init has failed", () => {
    FakeRenderer.throwOnConstruct = true;
    send(INIT);
    posted = [];
    send({ cmd: "render", seq: 2 });
    expect(posted).toEqual([{ type: "frameSkipped", seq: 2 }]);
  });

  it("answers frameSkipped once the renderer is disposed", () => {
    send(INIT);
    send({ cmd: "dispose" });
    posted = [];
    send({ cmd: "render", seq: 3 });
    expect(posted).toEqual([{ type: "frameSkipped", seq: 3 }]);
  });

  it("answers frameSkipped between photos, and the frame once the next source is set", () => {
    send(INIT);
    send({ cmd: "clearSource" });
    posted = [];
    send({ cmd: "render", seq: 4, wantHistogram: true });
    expect(posted).toEqual([{ type: "frameSkipped", seq: 4 }]);

    send({ cmd: "setImage", image: CACHED, maxEdge: 4096 });
    posted = [];
    send({ cmd: "render", seq: 5 });
    expect(posted).toEqual([expect.objectContaining({ type: "frame", seq: 5 })]);
  });

  it("answers renderError to a render that throws, with no frame and no generic error", () => {
    send(INIT);
    posted = [];
    FakeRenderer.renderError = new Error("Shader compile failed: boom");
    send({ cmd: "render", seq: 9 });
    expect(posted).toEqual([
      { type: "renderError", seq: 9, message: "Shader compile failed: boom" },
    ]);
  });

  it("answers renderError when the histogram it asked for throws, and frees the frame", () => {
    send(INIT);
    posted = [];
    FakeRenderer.histogramError = new Error("readPixels failed");
    send({ cmd: "render", seq: 10, wantHistogram: true });
    expect(posted).toEqual([{ type: "renderError", seq: 10, message: "readPixels failed" }]);
    expect(handedOut).toHaveLength(1);
    expect(handedOut[0].closed).toBe(true);
  });

  it("answers each render of a run once, by its seq, in order", () => {
    send({ cmd: "render", seq: 1 });
    send(INIT);
    send({ cmd: "render", seq: 2 });
    send({ cmd: "clearSource" });
    send({ cmd: "render", seq: 3 });
    FakeRenderer.resident.add("next");
    send({ cmd: "bindSource", reqId: 1, key: "next" });
    FakeRenderer.renderError = new Error("lost context");
    send({ cmd: "render", seq: 4 });
    FakeRenderer.renderError = null;
    send({ cmd: "render", seq: 5 });

    const answers = posted.flatMap((msg) =>
      msg.type === "frame" || msg.type === "frameSkipped" || msg.type === "renderError"
        ? [[msg.type, msg.seq]]
        : [],
    );
    expect(answers).toEqual([
      ["frameSkipped", 1],
      ["frame", 2],
      ["frameSkipped", 3],
      ["renderError", 4],
      ["frame", 5],
    ]);
    expect(posted.some((msg) => msg.type === "error")).toBe(false);
  });
});

const CACHED = {
  kind: "float16" as const,
  data: new Uint16Array(4 * 4),
  width: 2,
  height: 2,
};

// Between photos the develop view shows the next photo's stored preview, drawn
// on the main thread, until that photo's own source arrives. A frame or
// histogram rendered meanwhile would show the previous photo, or the new one
// edited twice, so the worker draws neither until a source is bound again.
describe("render-worker between photos", () => {
  const answers = () =>
    posted.filter((msg) => msg.type === "frame" || msg.type === "histogram");

  beforeEach(() => {
    send({ cmd: "init", width: 64, height: 64, highBitDepth: false });
    send({ cmd: "clearSource" });
    posted = [];
  });

  it("posts no frame and no histogram until a source arrives", () => {
    send({ cmd: "render", seq: 1, wantHistogram: true });
    send({ cmd: "computeHistogram", wantExtended: true });
    expect(answers()).toEqual([]);
  });

  it("answers again once the next photo's image is set", () => {
    send({ cmd: "setImage", image: CACHED, maxEdge: 4096 });
    send({ cmd: "render", seq: 2, wantHistogram: true });
    send({ cmd: "computeHistogram" });
    expect(answers().map((msg) => msg.type)).toEqual(["frame", "histogram"]);
    expect(answers()[0]).toMatchObject({ histogram: { luma: expect.any(Uint32Array) } });
  });

  it("stays quiet when the next photo's image can't be set", () => {
    FakeRenderer.failing.setImage = new Error("texImage2D failed");
    send({ cmd: "setImage", image: CACHED, maxEdge: 4096 });
    send({ cmd: "render", seq: 3, wantHistogram: true });
    expect(answers()).toEqual([]);
  });

  it("answers again once its decoded source is uploaded and bound", () => {
    send({ cmd: "uploadSource", target: "main", key: "next", image: CACHED });
    send({ cmd: "render", seq: 4 });
    expect(answers().map((msg) => msg.type)).toEqual(["frame"]);
  });

  it("stays quiet after uploads that don't bind the develop source", () => {
    send({ cmd: "uploadSource", target: "main", key: "neighbour", image: CACHED, bind: false });
    send({ cmd: "uploadSource", target: "thumb", key: "edited", image: CACHED });
    send({ cmd: "render", seq: 5 });
    expect(answers()).toEqual([]);
  });

  it("answers again once a resident source is bound, not after a miss", () => {
    send({ cmd: "bindSource", reqId: 1, key: "evicted" });
    send({ cmd: "render", seq: 6 });
    expect(answers()).toEqual([]);

    FakeRenderer.resident.add("next");
    send({ cmd: "bindSource", reqId: 2, key: "next" });
    send({ cmd: "render", seq: 7 });
    expect(answers().map((msg) => msg.type)).toEqual(["frame"]);
  });
});

// The develop renderer lets go of the source it held before it takes the next, so one it
// can't take (an upload that throws) leaves it with no picture of the photo. The view is
// told which source failed, and nothing is drawn until another source is taken.
describe("render-worker a source it can't take", () => {
  beforeEach(() => {
    send({ cmd: "init", width: 64, height: 64, highBitDepth: false });
    posted = [];
  });

  it.each<[string, WorkerRequest]>([
    ["an image set", { cmd: "setImage", image: CACHED, maxEdge: 4096 }],
    ["an upload that binds it", { cmd: "uploadSource", target: "main", key: "next", image: CACHED }],
  ])("tells the view the number of the source that failed: %s", (_label, request) => {
    const failed = new Error("texImage2D failed");
    FakeRenderer.failing = { setImage: failed, uploadSource: failed };
    send({ cmd: "clearSource" });
    send(request);
    expect(posted).toEqual([{ type: "sourceError", sourceGen: 1, message: "texImage2D failed" }]);
  });

  it("draws nothing after it, though a picture of the photo was drawn before", () => {
    send({ cmd: "setImage", image: CACHED, maxEdge: 4096 });
    FakeRenderer.failing.uploadSource = new Error("out of memory");
    send({ cmd: "uploadSource", target: "main", key: "next", image: CACHED });
    send({ cmd: "render", seq: 1, wantHistogram: true });
    send({ cmd: "computeHistogram" });
    expect(posted.map((msg) => msg.type)).toEqual(["sourceError", "frameSkipped"]);
  });

  it("draws again once the next source is taken", () => {
    FakeRenderer.failing.setImage = new Error("texImage2D failed");
    send({ cmd: "setImage", image: CACHED, maxEdge: 4096 });
    FakeRenderer.failing = {};
    send({ cmd: "uploadSource", target: "main", key: "next", image: CACHED });
    send({ cmd: "render", seq: 2 });
    expect(posted.at(-1)).toMatchObject({ type: "frame", seq: 2, sourceGen: 2 });
  });

  // The view waits for the answer before it loads the photo itself; loaded and uploaded
  // again, it replaces the entry that couldn't be bound.
  it("answers a bind that throws as a miss, and draws nothing until a source is taken", () => {
    FakeRenderer.resident.add("next");
    FakeRenderer.failing.bindSource = new Error("out of memory");
    send({ cmd: "bindSource", reqId: 3, key: "next" });
    send({ cmd: "render", seq: 8 });
    expect(posted).toEqual([
      { type: "sourceBound", reqId: 3, hit: false },
      { type: "error", message: "out of memory" },
      { type: "frameSkipped", seq: 8 },
    ]);

    FakeRenderer.failing = {};
    send({ cmd: "uploadSource", target: "main", key: "next", image: CACHED });
    send({ cmd: "render", seq: 9 });
    expect(posted.at(-1)).toMatchObject({ type: "frame", seq: 9 });
  });

  it("reports an upload that doesn't bind the develop source as any other failure", () => {
    FakeRenderer.failing.uploadSource = new Error("out of memory");
    send({ cmd: "uploadSource", target: "main", key: "neighbour", image: CACHED, bind: false });
    send({ cmd: "render", seq: 3 });
    expect(posted.map((msg) => msg.type)).toEqual(["error", "frame"]);
  });
});

// A frame says which source it was drawn from: the size the develop renderer holds it at,
// and a number the worker moves on each time that renderer is handed another source. The
// develop view sizes its crop from the one, and tells the camera preview from the final
// image by the other. The bridge counts the sources it sends the same way.
describe("render-worker frame source", () => {
  const INIT: WorkerRequest = { cmd: "init", width: 64, height: 64, highBitDepth: false };
  const image = (width: number, height: number) => ({
    kind: "float16" as const,
    data: new Uint16Array(width * height * 4),
    width,
    height,
  });
  let seq = 0;

  /** The source the frame answering a render sent now was drawn from. */
  function drawnFrom() {
    send({ cmd: "render", seq: ++seq });
    const answer = posted.at(-1);
    if (answer?.type !== "frame") throw new Error(`render answered with ${answer?.type}`);
    return { width: answer.sourceWidth, height: answer.sourceHeight, gen: answer.sourceGen };
  }

  it("carries the size of the image set, and that source's number", () => {
    send(INIT);
    send({ cmd: "setImage", image: image(30, 20), maxEdge: 4096 });
    expect(drawnFrom()).toEqual({ width: 30, height: 20, gen: 1 });
  });

  it("moves the number on with each source bound, and only then", () => {
    send(INIT);
    expect(drawnFrom()).toEqual({ width: 0, height: 0, gen: 0 });

    send({ cmd: "setImage", image: image(30, 20), maxEdge: 4096 });
    expect(drawnFrom()).toEqual({ width: 30, height: 20, gen: 1 });
    expect(drawnFrom()).toEqual({ width: 30, height: 20, gen: 1 });

    send({ cmd: "uploadSource", target: "main", key: "a", image: image(60, 40) });
    expect(drawnFrom()).toEqual({ width: 60, height: 40, gen: 2 });

    send({ cmd: "uploadSource", target: "main", key: "b", image: image(90, 60), bind: false });
    send({ cmd: "uploadSource", target: "thumb", key: "c", image: image(12, 8) });
    send({ cmd: "bindSource", reqId: 1, key: "gone" });
    expect(drawnFrom()).toEqual({ width: 60, height: 40, gen: 2 });

    FakeRenderer.resident.add("b");
    FakeRenderer.residentSize = { width: 90, height: 60 };
    send({ cmd: "bindSource", reqId: 2, key: "b" });
    expect(drawnFrom()).toEqual({ width: 90, height: 60, gen: 3 });
  });

  it("counts a source sent while there is no renderer, as the bridge does", () => {
    FakeRenderer.throwOnConstruct = true;
    send(INIT);
    send({ cmd: "setImage", image: image(30, 20), maxEdge: 4096 });
    send({ cmd: "uploadSource", target: "main", key: "a", image: image(60, 40) });
    FakeRenderer.throwOnConstruct = false;
    send(INIT);
    expect(drawnFrom().gen).toBe(2);
  });

  it("counts a source whose upload throws", () => {
    send(INIT);
    FakeRenderer.failing.setImage = new Error("texImage2D failed");
    send({ cmd: "setImage", image: image(30, 20), maxEdge: 4096 });
    FakeRenderer.failing = {};
    expect(posted.at(-1)).toMatchObject({ type: "sourceError", sourceGen: 1 });
    send({ cmd: "setImage", image: image(60, 40), maxEdge: 4096 });
    expect(drawnFrom().gen).toBe(2);
  });
});

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

  describe("with a capture's bag patch", () => {
    const PARAMS = { exposure: 0 } as unknown as DevelopParams;

    it("renders the patch over the merged bag, then restores the merged bag", () => {
      send(INIT);
      whole({ "a.gain": 1, "b.take": 2 });
      patch({ "a.gain": 3 });
      send({ cmd: "capture", reqId: 7, params: PARAMS, pipeline: BUILTIN_RESOLVED, bagPatch: { "a.mode": 1 } });

      const live = develop();
      const merged = { "a.gain": 3, "b.take": 2 };
      expect(live.contributedSeen.slice(-2)).toEqual([{ ...merged, "a.mode": 1 }, merged]);
      expect(live.contributedParams).toEqual(merged);
      expect(posted.at(-1)).toMatchObject({ type: "captured", reqId: 7 });
    });

    it("leaves the bag alone without a patch", () => {
      send(INIT);
      whole({ "a.gain": 1 });
      const seen = develop().contributedSeen.length;
      send({ cmd: "capture", reqId: 8, params: PARAMS, pipeline: BUILTIN_RESOLVED });
      expect(develop().contributedSeen.length).toBe(seen);
    });

    it("restores the merged bag even when the render throws", () => {
      send(INIT);
      whole({ "a.gain": 1 });
      FakeRenderer.renderError = new Error("Shader compile failed: boom");
      send({ cmd: "capture", reqId: 9, params: PARAMS, pipeline: BUILTIN_RESOLVED, bagPatch: { "a.mode": 1 } });
      FakeRenderer.renderError = null;
      expect(posted.at(-1)).toMatchObject({ type: "captured", reqId: 9 });
      expect(develop().contributedParams).toEqual({ "a.gain": 1 });
    });
  });
});

// The bridge posts the params whole first, and first after every init, then only the
// top-level fields that changed. A patch is merged into the params the worker holds as a
// new object, and the fields it doesn't name stay the very objects the renderer drew
// last: the renderer signs every brush dab of the masks and retouch again unless they
// are the arrays it signed last.
describe("render-worker params patches", () => {
  const INIT: WorkerRequest = { cmd: "init", width: 64, height: 64, highBitDepth: false };
  const mask = (id: string): Mask => ({
    id,
    name: id,
    visible: true,
    invert: false,
    opacity: 100,
    adj: defaultMaskAdjustments(),
    panels: [],
    components: [],
  });
  const spot = (id: string): RetouchSpot => ({
    id,
    shape: "circle",
    mode: "heal",
    visible: true,
    dstX: 0.5,
    dstY: 0.5,
    srcX: 0.2,
    srcY: 0.2,
    radius: 0.05,
    feather: 50,
    opacity: 100,
  });
  const painted = (): DevelopParams => ({
    ...DEFAULT_DEVELOP_PARAMS,
    masks: [mask("m1")],
    retouch: [spot("s1")],
  });
  const whole = (params: DevelopParams) => send({ cmd: "setParams", params });
  const patch = (set: Partial<DevelopParams>, remove: string[] = []) =>
    send({ cmd: "patchParams", set, remove });
  const develop = () => FakeRenderer.instances[0];

  it("keeps the masks and retouch the very arrays the renderer saw, patch after patch", () => {
    send(INIT);
    const base = painted();
    whole(base);
    patch({ exposure: 1 });
    patch({ exposure: 2 });

    const seen = develop().paramsSeen;
    expect(seen).toHaveLength(3);
    expect(seen[1].masks).toBe(seen[0].masks);
    expect(seen[1].retouch).toBe(seen[0].retouch);
    expect(seen[2].masks).toBe(seen[0].masks);
    expect(seen[2].retouch).toBe(seen[0].retouch);
    expect(seen[2]).toEqual({ ...base, exposure: 2 });
  });

  it("merges a patch into a new object, leaving the params it built on as they were", () => {
    send(INIT);
    const base = painted();
    whole(base);
    patch({ exposure: 1 });
    const [first, merged] = develop().paramsSeen;
    expect(merged).not.toBe(first);
    expect(merged.exposure).toBe(1);
    expect(base.exposure).toBe(DEFAULT_DEVELOP_PARAMS.exposure);
  });

  it("hands over a field the patch names as the value it carries", () => {
    send(INIT);
    const base = painted();
    const masks = [mask("m1"), mask("m2")];
    whole(base);
    patch({ masks });
    const [, merged] = develop().paramsSeen;
    expect(merged.masks).toBe(masks);
    expect(merged.retouch).toBe(base.retouch);
  });

  it("drops the keys a patch removes", () => {
    send(INIT);
    const fromOlderEdit = { ...painted(), lensProfile: "legacy" };
    whole(fromOlderEdit);
    patch({}, ["lensProfile"]);
    const [, merged] = develop().paramsSeen;
    expect(merged).not.toHaveProperty("lensProfile");
    expect(merged).toEqual(painted());
  });

  it("holds exactly a whole post that arrives after patches, and patches it next", () => {
    send(INIT);
    whole(painted());
    patch({ exposure: 1 });
    const replacement = painted();
    whole(replacement);
    expect(develop().paramsSeen.at(-1)).toBe(replacement);

    patch({ contrast: 5 });
    const merged = develop().paramsSeen.at(-1);
    expect(merged).toEqual({ ...replacement, contrast: 5 });
    expect(merged?.masks).toBe(replacement.masks);
  });

  it("merges a patch that arrives while init is failing, for the retry's renderer", () => {
    FakeRenderer.throwOnConstruct = true;
    send(INIT);
    const base = painted();
    whole(base);
    patch({ exposure: 1 });
    FakeRenderer.throwOnConstruct = false;
    send(INIT);

    const seen = develop().paramsSeen;
    expect(seen).toEqual([{ ...base, exposure: 1 }]);
    expect(seen[0].masks).toBe(base.masks);
  });

  it("seeds a renderer made after the patches with the merged params", () => {
    send(INIT);
    whole(painted());
    patch({ exposure: 1 });
    send(INIT);
    const [first, second] = FakeRenderer.instances;
    expect(second.paramsSeen).toHaveLength(1);
    expect(second.paramsSeen[0]).toBe(first.paramsSeen[1]);
  });

  it("restores the merged params after a capture, not the params the patch built on", () => {
    send(INIT);
    whole(painted());
    patch({ exposure: 1 });
    const before = { ...painted(), exposure: -1 };
    send({ cmd: "capture", reqId: 1, params: before, pipeline: BUILTIN_RESOLVED });

    const seen = develop().paramsSeen;
    expect(seen).toHaveLength(4);
    expect(seen[2]).toBe(before);
    expect(seen[3]).toBe(seen[1]);
    expect(posted.at(-1)).toMatchObject({ type: "captured", reqId: 1 });
  });

  it("answers a patch with nothing", () => {
    send(INIT);
    whole(painted());
    const before = posted.length;
    patch({ exposure: 1 });
    expect(posted).toHaveLength(before);
  });

  it("reports a patch that comes before any params, and takes nothing from it", () => {
    send(INIT);
    posted = [];
    patch({ exposure: 1 });
    expect(posted).toEqual([{ type: "error", message: expect.stringContaining("patch") }]);
    expect(develop().paramsSeen).toEqual([]);

    send(INIT);
    expect(FakeRenderer.instances[1].paramsSeen).toEqual([]);
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

  // A thumbnail is a JPEG unless the request says its bytes carry data: then it is a
  // PNG, which hands back every 8-bit channel value the renderer wrote.
  describe("encoding", () => {
    const fromSource = (over: Partial<Extract<WorkerRequest, { cmd: "renderThumbnailFromSource" }>> = {}) => {
      FakeRenderer.resident.add("photo-1");
      const request: WorkerRequest = {
        cmd: "renderThumbnailFromSource",
        requestId: "t1",
        key: "photo-1",
        params: DEFAULT_DEVELOP_PARAMS,
        asShotTemperature: 5500,
        maxEdge: 256,
        pipeline: BUILTIN_RESOLVED,
        ...over,
      };
      return request;
    };
    const REQUESTS: [string, (over: { quality?: number; lossless?: boolean }) => WorkerRequest][] = [
      ["a bitmap sent with the render", (over) => thumbnail(over)],
      ["a resident source", (over) => fromSource(over)],
    ];

    it.each(REQUESTS)("encodes %s as a JPEG at 0.8 by default", (_label, request) => {
      send(request({}));
      expect(encodings).toEqual([{ type: "image/jpeg", quality: 0.8 }]);
    });

    it.each(REQUESTS)("encodes %s as a JPEG at the quality asked for", (_label, request) => {
      send(request({ quality: 0.9 }));
      expect(encodings).toEqual([{ type: "image/jpeg", quality: 0.9 }]);
    });

    it.each(REQUESTS)("encodes %s as a PNG when the request is lossless", (_label, request) => {
      send(request({ lossless: true }));
      expect(encodings).toEqual([{ type: "image/png" }]);
    });

    it.each(REQUESTS)("encodes %s as a JPEG when lossless is false", (_label, request) => {
      send(request({ lossless: false, quality: 0.9 }));
      expect(encodings).toEqual([{ type: "image/jpeg", quality: 0.9 }]);
    });

    it.each(REQUESTS)("lets lossless win over a quality on %s", (_label, request) => {
      send(request({ lossless: true, quality: 0.9 }));
      expect(encodings).toEqual([{ type: "image/png" }]);
    });

    it("answers a lossless thumbnail with the blob it encoded", async () => {
      send(thumbnail({ lossless: true }));
      await Promise.resolve();
      expect(posted.at(-1)).toMatchObject({ type: "thumbnail", requestId: "t1" });
    });

    const ENCODES = REQUESTS.flatMap(([label, request]) => [
      [`${label} as a JPEG`, request, {}] as const,
      [`${label} as a PNG`, request, { lossless: true }] as const,
    ]);

    it.each(ENCODES)("settles %s with thumbnailError when the encode rejects", async (_label, request, over) => {
      encodeError = new Error("convertToBlob rejected");
      send(request(over));
      await Promise.resolve();
      expect(encodings).toHaveLength(1);
      expect(posted).toEqual([
        { type: "thumbnailError", requestId: "t1", message: "convertToBlob rejected" },
      ]);
    });
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

// A Linux display profile converts what the live view shows. Thumbnails are
// written to disk and extensions measure captures, so neither takes it, unless
// a capture asks for the frame as it is drawn on screen.
describe("render-worker display profile", () => {
  const INIT: WorkerRequest = { cmd: "init", width: 64, height: 64, highBitDepth: false };
  const DISPLAY: MonitorTransform = {
    matrix: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
    curve: "gamma22",
  };
  const capture = (asShown?: boolean): WorkerRequest => ({
    cmd: "capture",
    reqId: 1,
    params: DEFAULT_DEVELOP_PARAMS,
    pipeline: BUILTIN_RESOLVED,
    asShown,
  });

  it("hands it to the live renderer and never to the thumbnail one", () => {
    send(INIT);
    send({ cmd: "setMonitorTransform", transform: DISPLAY });
    send(thumbnail());
    const [live, thumb] = FakeRenderer.instances;
    expect(live.monitorTransform).toBe(DISPLAY);
    expect(thumb.renderedWith).toEqual([null]);
  });

  it("seeds a renderer made after it arrived", () => {
    FakeRenderer.throwOnConstruct = true;
    send(INIT);
    send({ cmd: "setMonitorTransform", transform: DISPLAY });
    FakeRenderer.throwOnConstruct = false;
    send(INIT);
    expect(FakeRenderer.instances[0].monitorTransform).toBe(DISPLAY);
  });

  it("captures without it unless asked for the frame as shown", () => {
    send(INIT);
    send({ cmd: "setMonitorTransform", transform: DISPLAY });
    send(capture());
    send(capture(true));
    const live = FakeRenderer.instances[0];
    expect(live.renderedWith).toEqual([null, DISPLAY]);
    expect(live.monitorTransform).toBe(DISPLAY);
  });

  it("holds it again after a capture whose render fails", () => {
    send(INIT);
    send({ cmd: "setMonitorTransform", transform: DISPLAY });
    FakeRenderer.renderError = new Error("boom");
    send(capture());
    expect(FakeRenderer.instances[0].monitorTransform).toBe(DISPLAY);
    expect(posted.at(-1)).toMatchObject({ type: "captured", reqId: 1 });
  });
});

// A wide-gamut screen shows the live view in P3. Thumbnails are stored and
// extensions measure captures, so neither takes it, unless a capture asks for
// the frame as it is drawn on screen.
describe("render-worker display space", () => {
  const INIT: WorkerRequest = { cmd: "init", width: 64, height: 64, highBitDepth: false };
  const P3: WorkerRequest = { cmd: "setDisplaySpace", space: "display-p3" };
  const capture = (asShown?: boolean): WorkerRequest => ({
    cmd: "capture",
    reqId: 1,
    params: DEFAULT_DEVELOP_PARAMS,
    pipeline: BUILTIN_RESOLVED,
    asShown,
  });

  it("hands it to the live renderer and never to the thumbnail one", () => {
    send(INIT);
    send(P3);
    send(thumbnail());
    const [live, thumb] = FakeRenderer.instances;
    expect(live.displaySpace).toBe("display-p3");
    expect(thumb.displaySpaceSeen).toEqual([]);
    expect(thumb.renderedIn).toEqual(["srgb"]);
  });

  it("seeds a renderer made after it arrived", () => {
    FakeRenderer.throwOnConstruct = true;
    send(INIT);
    send(P3);
    FakeRenderer.throwOnConstruct = false;
    send(INIT);
    expect(FakeRenderer.instances[0].displaySpace).toBe("display-p3");
  });

  it("captures in sRGB unless asked for the frame as shown", () => {
    send(INIT);
    send(P3);
    send(capture());
    send(capture(true));
    const live = FakeRenderer.instances[0];
    expect(live.renderedIn).toEqual(["srgb", "display-p3"]);
    expect(live.displaySpace).toBe("display-p3");
  });

  it("holds it again after a capture whose render fails", () => {
    send(INIT);
    send(P3);
    FakeRenderer.renderError = new Error("boom");
    send(capture());
    expect(FakeRenderer.instances[0].displaySpace).toBe("display-p3");
    expect(posted.at(-1)).toMatchObject({ type: "captured", reqId: 1 });
  });
});

// Soft proofing previews the export space in the live view. Thumbnails are
// stored and extensions measure captures, so neither takes it, unless a
// capture asks for the frame as it is drawn on screen.
describe("render-worker proof", () => {
  const INIT: WorkerRequest = { cmd: "init", width: 64, height: 64, highBitDepth: false };
  const PROOF: WorkerRequest = { cmd: "setProof", space: "adobe-rgb" };
  const capture = (asShown?: boolean): WorkerRequest => ({
    cmd: "capture",
    reqId: 1,
    params: DEFAULT_DEVELOP_PARAMS,
    pipeline: BUILTIN_RESOLVED,
    asShown,
  });

  it("hands it to the live renderer and never to the thumbnail one", () => {
    send(INIT);
    send(PROOF);
    send(thumbnail());
    const [live, thumb] = FakeRenderer.instances;
    expect(live.proofSpace).toBe("adobe-rgb");
    expect(thumb.renderedProof).toEqual([null]);

    send({ cmd: "setProof", space: null });
    expect(live.proofSpace).toBeNull();
  });

  it("seeds a renderer made after it arrived", () => {
    FakeRenderer.throwOnConstruct = true;
    send(INIT);
    send(PROOF);
    FakeRenderer.throwOnConstruct = false;
    send(INIT);
    expect(FakeRenderer.instances[0].proofSpace).toBe("adobe-rgb");
  });

  it("captures without it unless asked for the frame as shown", () => {
    send(INIT);
    send(PROOF);
    send(capture());
    send(capture(true));
    const live = FakeRenderer.instances[0];
    expect(live.renderedProof).toEqual([null, "adobe-rgb"]);
    expect(live.proofSpace).toBe("adobe-rgb");
  });

  it("holds it again after a capture whose render fails", () => {
    send(INIT);
    send(PROOF);
    FakeRenderer.renderError = new Error("boom");
    send(capture());
    expect(FakeRenderer.instances[0].proofSpace).toBe("adobe-rgb");
    expect(posted.at(-1)).toMatchObject({ type: "captured", reqId: 1 });
  });
});

// The histogram (and Auto Tone and Auto WB, which read it) and Upright redraw
// with what the last render left bound. A capture renders its own params and
// bag, a gain map say, and restores only what the worker holds, so after one
// the worker draws the live view again before it measures.
describe("render-worker measuring after a capture", () => {
  const INIT: WorkerRequest = { cmd: "init", width: 64, height: 64, highBitDepth: false };
  const LIVE = { ...DEFAULT_DEVELOP_PARAMS, exposure: 1 };
  const BEFORE = { ...DEFAULT_DEVELOP_PARAMS, exposure: -1 };
  const BAG = { "a.gain": 2 };
  const PATCHED: WorkerRequest = {
    cmd: "capture",
    reqId: 1,
    params: BEFORE,
    pipeline: BUILTIN_RESOLVED,
    bagPatch: { "a.mode": 1 },
  };
  const MEASURES: [string, WorkerRequest, "computeHistogram" | "readDownscaledPixels"][] = [
    ["a histogram", { cmd: "computeHistogram", wantExtended: true }, "computeHistogram"],
    ["an Upright analysis", { cmd: "analyzeUpright", reqId: 2, mode: "auto" }, "readDownscaledPixels"],
  ];
  const develop = () => FakeRenderer.instances[0];

  /** The live view drawn once, then its log cleared. */
  function liveView() {
    send(INIT);
    send({ cmd: "setParams", params: LIVE });
    send({ cmd: "setContributedParams", bag: BAG });
    send({ cmd: "render", seq: 1 });
    develop().calls = [];
    develop().drawn = [];
  }

  it.each(MEASURES)("draws the live view before %s after a patched capture", (_label, measure, readback) => {
    liveView();
    send(PATCHED);
    const bitmaps = handedOut.length;
    send(measure);
    expect(develop().calls).toEqual(["render", "render", readback]);
    expect(develop().drawn.map(({ params, bag }) => ({ params, bag }))).toEqual([
      { params: BEFORE, bag: { ...BAG, "a.mode": 1 } },
      { params: LIVE, bag: BAG },
    ]);
    // The live frame stays on the canvas: nothing is handed to the view.
    expect(handedOut).toHaveLength(bitmaps);
  });

  it.each(MEASURES)("draws nothing extra before %s with no capture since the last render", (_label, measure, readback) => {
    liveView();
    send(measure);
    send(PATCHED);
    send({ cmd: "render", seq: 2 });
    develop().calls = [];
    send(measure);
    expect(develop().calls).toEqual([readback]);
  });

  it.each(MEASURES)("measures %s twice after a capture, drawing the live view once", (_label, measure, readback) => {
    liveView();
    send(PATCHED);
    send(measure);
    send(measure);
    expect(develop().calls).toEqual(["render", "render", readback, readback]);
  });

  it.each(MEASURES)("draws the live view before %s after a capture whose render failed", (_label, measure, readback) => {
    liveView();
    FakeRenderer.renderError = new Error("Shader compile failed: boom");
    send(PATCHED);
    FakeRenderer.renderError = null;
    send(measure);
    expect(develop().calls).toEqual(["render", "render", readback]);
    expect(develop().drawn.at(-1)).toMatchObject({ params: LIVE, bag: BAG });
  });

  it("still measures nothing between photos", () => {
    liveView();
    send(PATCHED);
    send({ cmd: "clearSource" });
    posted = [];
    send({ cmd: "computeHistogram" });
    expect(develop().calls).toEqual(["render"]);
    expect(posted).toEqual([]);
  });
});

// The clipping warning, the mask tint and the sharpening preview are drawn for
// the eye. A capture an extension measures (a gain map: shadow clipping would
// paint each of its zero-gain pixels blue) leaves them out; one asked for as
// shown keeps them, as it is drawn over the canvas.
describe("render-worker view overlays in captures", () => {
  const INIT: WorkerRequest = { cmd: "init", width: 64, height: 64, highBitDepth: false };
  const capture = (asShown?: boolean): WorkerRequest => ({
    cmd: "capture",
    reqId: 1,
    params: DEFAULT_DEVELOP_PARAMS,
    pipeline: BUILTIN_RESOLVED,
    asShown,
  });
  const overlays = () => FakeRenderer.instances[0].drawn.map((d) => d.overlays);

  it("captures for measuring without them, and as shown with them", () => {
    send(INIT);
    send(capture());
    send(capture(true));
    expect(overlays()).toEqual([false, true]);
  });

  it.each([undefined, true])("draws the live view with them again after a capture (asShown %s)", (asShown) => {
    send(INIT);
    send(capture(asShown));
    send({ cmd: "render", seq: 1 });
    expect(overlays()).toEqual([asShown === true, true]);
  });
});

// The eyedropper reads the live frame through the develop renderer. Every way
// out answers by reqId. A probe draws its own patch but binds the live frame's
// program again itself, so unlike a capture it leaves a readback nothing to redraw.
describe("render-worker probe", () => {
  const INIT: WorkerRequest = { cmd: "init", width: 64, height: 64, highBitDepth: false };
  const PROBE: WorkerRequest = { cmd: "probe", reqId: 3, u: 0.25, v: 0.75, point: "mask" };
  const develop = () => FakeRenderer.instances[0];

  it("reads the live renderer and answers by reqId", () => {
    FakeRenderer.probed = [-0.2, 0.6, -0.1];
    send(INIT);
    send(PROBE);
    expect(develop().probes).toEqual([{ u: 0.25, v: 0.75, point: "mask" }]);
    expect(posted.at(-1)).toEqual({ type: "probed", reqId: 3, rgb: [-0.2, 0.6, -0.1] });
  });

  it("answers null with no renderer", () => {
    send(PROBE);
    expect(posted).toEqual([{ type: "probed", reqId: 3, rgb: null }]);
  });

  it("answers null between photos, without reading the one before", () => {
    FakeRenderer.probed = [0.5, 0.5, 0.5];
    send(INIT);
    send({ cmd: "clearSource" });
    send(PROBE);
    expect(develop().probes).toEqual([]);
    expect(posted.at(-1)).toEqual({ type: "probed", reqId: 3, rgb: null });
  });

  it("answers null when the probe throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    FakeRenderer.probeError = new Error("Shader compile failed: boom");
    send(INIT);
    send(PROBE);
    expect(posted.at(-1)).toEqual({ type: "probed", reqId: 3, rgb: null });
  });

  it("measures a histogram after a probe without drawing the live view again", () => {
    send(INIT);
    send({ cmd: "render", seq: 1 });
    develop().calls = [];
    send(PROBE);
    send({ cmd: "computeHistogram" });
    expect(develop().calls).toEqual(["probe", "computeHistogram"]);
  });
});

/** A 2×1 frame as the renderer reads it: perceptual Rec.709, one value over 1, one under 0. */
const FLOAT_READ = { data: new Float32Array([0.5, 1.5, -0.25, 1, 0.2, 0.4, 0.8, 1]), width: 2, height: 1 };
/** Not the default space, so a worker that converts into the default shows. */
const WIDE: StageSpace = { encoding: "perceptual", primaries: "rec2020" };

/** `frame` holds FLOAT_READ converted into `space`, each pixel as the stage conversion makes it. */
function expectConverted(frame: FloatFrame | null, space: StageSpace) {
  if (!frame) throw new Error("no frame");
  expect([frame.width, frame.height, frame.space]).toEqual([FLOAT_READ.width, FLOAT_READ.height, space]);
  for (let i = 0; i < FLOAT_READ.data.length; i += 4) {
    const rgb: [number, number, number] = [FLOAT_READ.data[i], FLOAT_READ.data[i + 1], FLOAT_READ.data[i + 2]];
    const want = [...toStageSpace(rgb, space, "display"), 1];
    want.forEach((v, ch) => expect(frame.data[i + ch], `pixel ${i / 4} ch ${ch}`).toBeCloseTo(v, 6));
  }
}

// An extension's float capture of the live photo: drawn like a capture, with
// its own params, pipeline and bag patch, which the live view gets back after,
// read as floats at a capture point and converted here, before it is
// transferred. Every way out answers by reqId.
describe("render-worker float capture", () => {
  const INIT: WorkerRequest = { cmd: "init", width: 64, height: 64, highBitDepth: false };
  const LIVE = { ...DEFAULT_DEVELOP_PARAMS, exposure: 1 };
  const BEFORE = { ...DEFAULT_DEVELOP_PARAMS, exposure: -1 };
  const BAG = { "a.gain": 2 };
  const LINEAR = { encoding: "linear", primaries: "rec709" } as const;
  const CAPTURE: WorkerRequest = {
    cmd: "captureFloat",
    reqId: 5,
    params: BEFORE,
    pipeline: PICK,
    point: "pre-output",
    space: LINEAR,
    maxEdge: 1280,
    bagPatch: { "a.mode": 1 },
  };
  const develop = () => FakeRenderer.instances[0];

  /** The live view drawn once, then its log cleared. */
  function liveView() {
    send(INIT);
    send({ cmd: "setParams", params: LIVE });
    send({ cmd: "setContributedParams", bag: BAG });
    send({ cmd: "render", seq: 1 });
    develop().calls = [];
    posted = [];
    transferred = [];
  }

  it("answers with the frame converted into the space asked for, transferred, by reqId", () => {
    FakeRenderer.floatFrame = FLOAT_READ;
    liveView();
    send(CAPTURE);
    expect(posted).toHaveLength(1);
    const reply = posted[0];
    if (reply.type !== "capturedFloat" || !reply.frame) throw new Error(`no frame: ${JSON.stringify(reply)}`);
    expect(reply.reqId).toBe(5);
    expect(reply.frame).toMatchObject({ width: 2, height: 1, space: LINEAR, point: "pre-output" });
    const want = [...FLOAT_READ.data].map((v, i) => (i % 4 === 3 ? 1 : decodePerceptual(v)));
    [...reply.frame.data].forEach((v, i) => expect(v, `entry ${i}`).toBeCloseTo(want[i], 6));
    expect(transferred[0]).toHaveLength(1);
    expect(transferred[0][0]).toBe(reply.frame.data.buffer);
  });

  it("converts into a space other than the default, as the stage conversion does", () => {
    FakeRenderer.floatFrame = FLOAT_READ;
    liveView();
    send({ ...CAPTURE, space: WIDE });
    expect(posted).toEqual([{ type: "capturedFloat", reqId: 5, frame: expect.anything() }]);
    expectConverted(posted[0].type === "capturedFloat" ? posted[0].frame : null, WIDE);
  });

  it("reads the point asked for", () => {
    FakeRenderer.floatFrame = FLOAT_READ;
    liveView();
    send({ ...CAPTURE, point: "output" });
    expect(develop().floatReads.map((r) => r.point)).toEqual(["output"]);
    expect(posted[0]).toMatchObject({ type: "capturedFloat", frame: { point: "output" } });
  });

  it("draws the frame capped at the long edge asked for", () => {
    FakeRenderer.floatFrame = FLOAT_READ;
    liveView();
    send(CAPTURE);
    send({ ...CAPTURE, maxEdge: 640 });
    send({ ...CAPTURE, maxEdge: Infinity });
    expect(develop().floatReads.map((r) => r.maxEdge)).toEqual([1280, 640, Infinity]);
  });

  it("draws with its params, pipeline and bag patch, then gives the live view back its own", () => {
    FakeRenderer.floatFrame = FLOAT_READ;
    liveView();
    send(CAPTURE);
    const live = develop();
    expect(live.floatReads).toEqual([
      expect.objectContaining({ params: BEFORE, bag: { ...BAG, "a.mode": 1 }, pipeline: PICK }),
    ]);
    expect(live.paramsSeen.at(-1)).toBe(LIVE);
    expect(live.contributedParams).toEqual(BAG);
    expect(live.pipeline).toEqual(BUILTIN_RESOLVED);
  });

  it("reads sRGB and unproofed, then shows the screen's space again", () => {
    const display: MonitorTransform = { matrix: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), curve: "gamma22" };
    liveView();
    send({ cmd: "setMonitorTransform", transform: display });
    send({ cmd: "setDisplaySpace", space: "display-p3" });
    send({ cmd: "setProof", space: "adobe-rgb" });
    send(CAPTURE);
    const live = develop();
    expect(live.floatReads.map((r) => r.screen)).toEqual([[null, "srgb", null]]);
    expect([live.monitorTransform, live.displaySpace, live.proofSpace]).toEqual([display, "display-p3", "adobe-rgb"]);
  });

  it("draws the live view again before the next histogram measures it", () => {
    FakeRenderer.floatFrame = FLOAT_READ;
    liveView();
    send(CAPTURE);
    send({ cmd: "computeHistogram" });
    expect(develop().calls).toEqual(["readFloatFrame", "render", "computeHistogram"]);
    expect(develop().drawn.at(-1)).toMatchObject({ params: LIVE, bag: BAG });
  });

  it("answers null with no renderer", () => {
    send(CAPTURE);
    expect(posted).toEqual([{ type: "capturedFloat", reqId: 5, frame: null }]);
  });

  it("answers null between photos, without reading the one before", () => {
    FakeRenderer.floatFrame = FLOAT_READ;
    liveView();
    send({ cmd: "clearSource" });
    send(CAPTURE);
    expect(develop().calls).toEqual([]);
    expect(posted).toEqual([{ type: "capturedFloat", reqId: 5, frame: null }]);
  });

  it("answers null without float render targets", () => {
    liveView();
    send(CAPTURE);
    expect(posted).toEqual([{ type: "capturedFloat", reqId: 5, frame: null }]);
  });

  it("answers null by reqId when the read throws, and gives the live view back its own", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    FakeRenderer.floatError = new Error("Shader compile failed: boom");
    liveView();
    send(CAPTURE);
    expect(posted).toEqual([{ type: "capturedFloat", reqId: 5, frame: null }]);
    const live = develop();
    expect(live.paramsSeen.at(-1)).toBe(LIVE);
    expect(live.contributedParams).toEqual(BAG);
    expect(live.pipeline).toEqual(BUILTIN_RESOLVED);
  });
});

// renderPhotoFloatFrame: a thumbnail request that carries `float` is read as
// floats at its point and converted into its space here, as a float capture
// is, instead of being encoded. It draws with the request's own bag and
// pipeline, which the thumb renderer gives back after, and a miss or a
// failure is answered as a blob request's is.
describe("render-worker float thumbnails", () => {
  const FLOAT = { point: "output", space: WIDE } as const;
  const BAG = { "a.gain": 2 };
  const OWN_BAG = { "a.gain": 9 };
  type Over = { contributedParams?: Record<string, unknown> };
  const fromSource = (over: Over = {}): WorkerRequest => ({
    cmd: "renderThumbnailFromSource",
    requestId: "t1",
    key: "photo-1",
    params: DEFAULT_DEVELOP_PARAMS,
    asShotTemperature: 5500,
    maxEdge: 640,
    pipeline: PICK,
    float: FLOAT,
    ...over,
  });
  const REQUESTS: [string, (over?: Over) => WorkerRequest][] = [
    ["a bitmap sent with the render", (over) => thumbnail({ pipeline: PICK, float: FLOAT, ...over })],
    [
      "a resident source",
      (over) => {
        FakeRenderer.resident.add("photo-1");
        return fromSource(over);
      },
    ],
  ];
  const thumb = () => FakeRenderer.instances[0];

  it.each(REQUESTS)("answers %s with the frame read at its point, converted into its space, transferred", (_label, request) => {
    FakeRenderer.floatFrame = FLOAT_READ;
    send(request());
    expect(posted).toEqual([{ type: "thumbnailFloat", requestId: "t1", frame: expect.objectContaining({ point: "output" }) }]);
    const reply = posted[0];
    const frame = reply.type === "thumbnailFloat" ? reply.frame : null;
    expectConverted(frame, WIDE);
    // The thumbnail is already drawn at its own measuring edge.
    expect(thumb().floatReads.map((r) => [r.point, r.maxEdge])).toEqual([["output", undefined]]);
    expect(transferred[0]).toHaveLength(1);
    expect(transferred[0][0]).toBe(frame?.data.buffer);
  });

  it.each(REQUESTS)("neither encodes %s nor draws it to the canvas", async (_label, request) => {
    FakeRenderer.floatFrame = FLOAT_READ;
    send(request());
    await Promise.resolve();
    expect(encodings).toEqual([]);
    expect(thumb().calls).toEqual(["readFloatFrame"]);
  });

  it.each(REQUESTS)("reads %s with its own bag and pipeline, then gives back the worker's", (_label, request) => {
    FakeRenderer.floatFrame = FLOAT_READ;
    send({ cmd: "setContributedParams", bag: BAG });
    send(request({ contributedParams: OWN_BAG }));
    expect(thumb().floatReads).toEqual([
      expect.objectContaining({ params: DEFAULT_DEVELOP_PARAMS, bag: OWN_BAG, pipeline: PICK }),
    ]);
    expect(thumb().contributedParams).toBe(BAG);
    expect(thumb().pipeline).toEqual(BUILTIN_RESOLVED);
  });

  it.each(REQUESTS)("answers %s with a null frame without float render targets", (_label, request) => {
    send(request());
    expect(posted).toEqual([{ type: "thumbnailFloat", requestId: "t1", frame: null }]);
    expect(transferred[0]).toEqual([]);
  });

  it.each(REQUESTS)("answers thumbnailError when reading %s throws, and gives back the worker's bag and pipeline", (_label, request) => {
    FakeRenderer.floatError = new Error("Shader compile failed: boom");
    send({ cmd: "setContributedParams", bag: BAG });
    send(request({ contributedParams: OWN_BAG }));
    expect(posted).toEqual([{ type: "thumbnailError", requestId: "t1", message: "Shader compile failed: boom" }]);
    expect(thumb().contributedParams).toBe(BAG);
    expect(thumb().pipeline).toEqual(BUILTIN_RESOLVED);
  });

  it("answers a miss with thumbnailMiss, reading nothing", () => {
    FakeRenderer.floatFrame = FLOAT_READ;
    send(fromSource());
    expect(posted).toEqual([{ type: "thumbnailMiss", requestId: "t1", key: "photo-1" }]);
    expect(thumb().floatReads).toEqual([]);
  });
});
