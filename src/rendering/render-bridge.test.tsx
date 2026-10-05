// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The bridge's recovery from a worker that cannot create its WebGL2 context.
// After a GPU reset Chromium refuses 3D contexts to the page for a while, and
// the crash-recovery reload lands inside that window: the first init fails
// although the GPU is back. Before this, `ready` never settled and Develop
// stayed grey until the app was restarted (SafeLight #96, round 5).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RenderBridge, disposeRenderBridge, getRenderBridge } from "./render-bridge";
import type { WorkerRequest, WorkerResponse } from "./render-worker";
import { normalizeParams } from "@/catalog/types";
import {
  registerPipeline,
  registerProcessingStage,
  unregisterProcessingStage,
  useRegistry,
} from "@/extensions/registry";
import { DEFAULT_PIPELINE, usePipelineStore } from "@/extensions/pipelines";
import type { ProcessingStageContribution } from "@/extensions/types";

class FakeWorker {
  static instances: FakeWorker[] = [];
  posted: WorkerRequest[] = [];
  transfers: Transferable[][] = [];
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminated = false;

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(msg: WorkerRequest, transfer: Transferable[] = []) {
    this.posted.push(msg);
    this.transfers.push(transfer);
  }

  terminate() {
    this.terminated = true;
  }

  reply(msg: WorkerResponse) {
    this.onmessage?.({ data: msg } as MessageEvent<WorkerResponse>);
  }
}

const inits = (worker: FakeWorker) => worker.posted.filter((m) => m.cmd === "init");
const initError: WorkerResponse = { type: "initError", message: "WebGL2 not supported" };

describe("RenderBridge init recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("retries init with growing delays until the worker reports ready", async () => {
    const bridge = new RenderBridge();
    const seen: string[] = [];
    bridge.setOnAvailability((availability) => seen.push(availability));
    const errors: string[] = [];
    bridge.setOnError((message) => errors.push(message));
    bridge.init(64, 64);
    const worker = FakeWorker.instances[0];
    expect(inits(worker)).toHaveLength(1);

    worker.reply(initError);
    expect(bridge.availability).toBe("retrying");
    expect(errors[0]).toContain("WebGL2 not supported");
    vi.advanceTimersByTime(999);
    expect(inits(worker)).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(inits(worker)).toHaveLength(2);

    worker.reply(initError);
    vi.advanceTimersByTime(1999);
    expect(inits(worker)).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(inits(worker)).toHaveLength(3);
    expect(inits(worker)[2]).toMatchObject({ cmd: "init", width: 64, height: 64 });

    let ready = false;
    void bridge.ready.then(() => {
      ready = true;
    });
    worker.reply({ type: "ready", pipelineFloat: true });
    await Promise.resolve();
    expect(ready).toBe(true);
    expect(bridge.pipelineFloat).toBe(true);
    expect(bridge.availability).toBe("ready");
    expect(seen).toEqual(["starting", "retrying", "retrying", "ready"]);
    bridge.dispose();
  });

  it("gives up after the retry budget and reports failed", () => {
    const bridge = new RenderBridge();
    bridge.setOnError(() => undefined);
    bridge.init(64, 64);
    const worker = FakeWorker.instances[0];
    for (let i = 0; i < 20; i++) {
      worker.reply(initError);
      vi.advanceTimersByTime(60_000);
    }
    expect(bridge.availability).toBe("failed");
    const attempts = inits(worker).length;
    expect(attempts).toBe(10);
    vi.advanceTimersByTime(600_000);
    expect(inits(worker)).toHaveLength(attempts);
    bridge.dispose();
  });

  it("keeps retrying for long enough to outlast Chromium's two-minute block", () => {
    const bridge = new RenderBridge();
    bridge.setOnError(() => undefined);
    bridge.init(64, 64);
    const worker = FakeWorker.instances[0];
    // Fail every attempt and let the bridge's own timers pace the next one;
    // the simulated time until it gives up is the window it covers.
    const gaveUp = () => bridge.availability === "failed";
    let elapsed = 0;
    for (;;) {
      worker.reply(initError);
      if (gaveUp()) break;
      const before = inits(worker).length;
      while (inits(worker).length === before) {
        vi.advanceTimersByTime(1_000);
        elapsed += 1_000;
      }
    }
    expect(elapsed).toBeGreaterThanOrEqual(150_000);
    bridge.dispose();
  });

  it("stops retrying once disposed", () => {
    const bridge = new RenderBridge();
    bridge.setOnError(() => undefined);
    bridge.init(64, 64);
    const worker = FakeWorker.instances[0];
    worker.reply(initError);
    bridge.dispose();
    vi.advanceTimersByTime(600_000);
    expect(inits(worker)).toHaveLength(1);
    expect(worker.terminated).toBe(true);
  });

  it("reports the current availability to a late subscriber", () => {
    const bridge = new RenderBridge();
    bridge.setOnError(() => undefined);
    bridge.init(64, 64);
    FakeWorker.instances[0].reply(initError);
    const seen: string[] = [];
    bridge.setOnAvailability((availability) => seen.push(availability));
    expect(seen).toEqual(["retrying"]);
    bridge.dispose();
  });
});

describe("RenderBridge display transform", () => {
  const AGX = { id: "test.agx", name: "AgX", glsl: "vec3 pipelineToDisplay(vec3 lin) { return lin; }" };

  beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
    useRegistry.setState({ pipelines: {} });
    registerPipeline("core", { id: DEFAULT_PIPELINE, name: "Built-in" });
    registerPipeline("test", AGX);
    usePipelineStore.setState({ activeId: DEFAULT_PIPELINE });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useRegistry.setState({ pipelines: {} });
    usePipelineStore.setState({ activeId: DEFAULT_PIPELINE });
  });

  const livePipelines = (worker: FakeWorker) =>
    worker.posted.flatMap((m) => (m.cmd === "setPipeline" ? [m.pipeline.id] : []));

  it("switches the live pipeline to the photo's pick, once per change", () => {
    const bridge = new RenderBridge();
    const worker = FakeWorker.instances[0];
    bridge.setParams(normalizeParams({ displayTransform: AGX.id }));
    bridge.setParams(normalizeParams({ displayTransform: AGX.id, exposure: 1 }));
    expect(livePipelines(worker)).toEqual([AGX.id]);

    bridge.setParams(normalizeParams({}));
    expect(livePipelines(worker)).toEqual([AGX.id, DEFAULT_PIPELINE]);
    bridge.dispose();
  });

  it("re-resolves a photo without a pick when the default changes", () => {
    const bridge = new RenderBridge();
    const worker = FakeWorker.instances[0];
    bridge.setParams(normalizeParams({}));
    usePipelineStore.setState({ activeId: AGX.id });
    bridge.syncPipeline();
    expect(livePipelines(worker)).toEqual([DEFAULT_PIPELINE, AGX.id]);
    bridge.dispose();
  });

  it("captures and renders thumbnails with the pick of the params they carry", () => {
    const bridge = new RenderBridge();
    const worker = FakeWorker.instances[0];
    const agx = normalizeParams({ displayTransform: AGX.id });
    void bridge.capture(agx);
    void bridge.renderThumbnailFromSource({
      requestId: "t1",
      key: "k",
      params: agx,
      asShotTemperature: 5000,
      maxEdge: 256,
    });
    bridge.renderThumbnail({
      requestId: "t2",
      image: { kind: "float16", data: new Uint16Array(4), width: 1, height: 1 },
      params: normalizeParams({}),
      asShotTemperature: 5000,
      maxEdge: 256,
    });
    const sent = worker.posted.flatMap((m) =>
      m.cmd === "capture" || m.cmd === "renderThumbnailFromSource" || m.cmd === "renderThumbnail"
        ? [[m.cmd, m.pipeline.id]]
        : [],
    );
    expect(sent).toEqual([
      ["capture", AGX.id],
      ["renderThumbnailFromSource", AGX.id],
      ["renderThumbnail", DEFAULT_PIPELINE],
    ]);
    bridge.dispose();
  });
});

// The live params are structured-cloned to the worker with every brush dab in
// them, and the Develop hook offers them again on each extension-slider frame.
// An object already posted is not posted twice, but a renderer that never saw
// it (a retried init) must still get it.
describe("RenderBridge params hand-off", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const posted = (worker: FakeWorker) =>
    worker.posted.flatMap((m) => (m.cmd === "setParams" ? [m.params] : []));

  it("posts the same params object once", () => {
    const bridge = new RenderBridge();
    const worker = FakeWorker.instances[0];
    const params = normalizeParams({});
    bridge.setParams(params);
    bridge.setParams(params);
    bridge.setParams(params);
    expect(posted(worker)).toHaveLength(1);
    expect(posted(worker)[0]).toBe(params);
    bridge.dispose();
  });

  it("posts every replacement, including a return to an earlier object", () => {
    const bridge = new RenderBridge();
    const worker = FakeWorker.instances[0];
    const first = normalizeParams({});
    const second = { ...first, exposure: 1 };
    bridge.setParams(first);
    bridge.setParams(second);
    bridge.setParams(first);
    bridge.setParams(first);
    expect(posted(worker)).toHaveLength(3);
    expect(posted(worker)[1]).toBe(second);
    expect(posted(worker)[2]).toBe(first);
    bridge.dispose();
  });

  it("posts the same params again once init is posted again", () => {
    const bridge = new RenderBridge();
    const worker = FakeWorker.instances[0];
    bridge.init(64, 64);
    const params = normalizeParams({});
    bridge.setParams(params);
    bridge.setParams(params);
    expect(posted(worker)).toHaveLength(1);
    bridge.init(64, 64);
    bridge.setParams(params);
    bridge.setParams(params);
    expect(posted(worker)).toHaveLength(2);
    bridge.dispose();
  });

  it("posts the same params again once a failed init is retried", () => {
    const bridge = new RenderBridge();
    bridge.setOnError(() => undefined);
    const worker = FakeWorker.instances[0];
    bridge.init(64, 64);
    const params = normalizeParams({});
    bridge.setParams(params);
    worker.reply(initError);
    vi.advanceTimersByTime(1_000);
    expect(inits(worker)).toHaveLength(2);
    bridge.setParams(params);
    bridge.setParams(params);
    expect(posted(worker)).toHaveLength(2);
    bridge.dispose();
  });
});

// The extension param bag is offered again on every Develop effect run. Posted whole
// it clones every value, brush dabs included, and the worker then holds a new object
// for each one, so the renderer bakes painted coverage again on every slider frame.
// Only what differs from the last bag posted is sent, so the worker's other values
// stay the objects the renderer has already seen.
describe("RenderBridge contributed params hand-off", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  type Whole = Extract<WorkerRequest, { cmd: "setContributedParams" }>;
  type Patch = Extract<WorkerRequest, { cmd: "patchContributedParams" }>;
  const wholes = (worker: FakeWorker) =>
    worker.posted.filter((m): m is Whole => m.cmd === "setContributedParams");
  const patches = (worker: FakeWorker) =>
    worker.posted.filter((m): m is Patch => m.cmd === "patchContributedParams");
  const bagPosts = (worker: FakeWorker) =>
    worker.posted.filter(
      (m) => m.cmd === "setContributedParams" || m.cmd === "patchContributedParams",
    );
  const dabs = (x: number) => [{ x, y: 0.5, radius: 0.1, feather: 0.5 }];
  const bagOf = () => ({ "a.gain": 1, "a.cov": dabs(0.2), "b.take": 0 });

  it("posts the first bag whole, the very object it was handed", () => {
    const bridge = new RenderBridge();
    const worker = FakeWorker.instances[0];
    const bag = bagOf();
    bridge.setContributedParams(bag);
    expect(bagPosts(worker)).toHaveLength(1);
    expect(wholes(worker)[0].bag).toBe(bag);
    bridge.dispose();
  });

  it("posts an empty first bag too, so the worker holds exactly what it was told", () => {
    const bridge = new RenderBridge();
    const worker = FakeWorker.instances[0];
    bridge.setContributedParams({});
    bridge.setContributedParams({});
    expect(bagPosts(worker)).toEqual([{ cmd: "setContributedParams", bag: {} }]);
    bridge.dispose();
  });

  it("posts nothing for the same bag, or for another object holding the same values", () => {
    const bridge = new RenderBridge();
    const worker = FakeWorker.instances[0];
    const bag = bagOf();
    bridge.setContributedParams(bag);
    bridge.setContributedParams(bag);
    bridge.setContributedParams({ ...bag });
    bridge.setContributedParams({ "b.take": 0, "a.cov": bag["a.cov"], "a.gain": 1 });
    expect(bagPosts(worker)).toHaveLength(1);
    bridge.dispose();
  });

  it("posts only the changed key, as the very value it was handed", () => {
    const bridge = new RenderBridge();
    const worker = FakeWorker.instances[0];
    const bag = bagOf();
    const painted = dabs(0.7);
    bridge.setContributedParams(bag);
    bridge.setContributedParams({ ...bag, "a.gain": 2 });
    bridge.setContributedParams({ ...bag, "a.gain": 2, "a.cov": painted });

    expect(bagPosts(worker).map((m) => m.cmd)).toEqual([
      "setContributedParams",
      "patchContributedParams",
      "patchContributedParams",
    ]);
    const [gain, cov] = patches(worker);
    expect(gain).toEqual({ cmd: "patchContributedParams", set: { "a.gain": 2 }, remove: [] });
    expect(Object.keys(cov.set)).toEqual(["a.cov"]);
    expect(cov.set["a.cov"]).toBe(painted);
    expect(cov.remove).toEqual([]);
    bridge.dispose();
  });

  it("treats an equal value that is not the same object as changed", () => {
    const bridge = new RenderBridge();
    const worker = FakeWorker.instances[0];
    const bag = bagOf();
    bridge.setContributedParams(bag);
    bridge.setContributedParams({ ...bag, "a.cov": structuredClone(bag["a.cov"]) });
    expect(patches(worker).map((m) => Object.keys(m.set))).toEqual([["a.cov"]]);
    bridge.dispose();
  });

  it("posts a dropped key as a removal, and an added one as a set", () => {
    const bridge = new RenderBridge();
    const worker = FakeWorker.instances[0];
    const bag = bagOf();
    const withoutTake = { "a.gain": bag["a.gain"], "a.cov": bag["a.cov"] };
    bridge.setContributedParams(bag);
    bridge.setContributedParams(withoutTake);
    bridge.setContributedParams({ ...withoutTake, "c.mix": 3 });

    expect(patches(worker)).toEqual([
      { cmd: "patchContributedParams", set: {}, remove: ["b.take"] },
      { cmd: "patchContributedParams", set: { "c.mix": 3 }, remove: [] },
    ]);
    bridge.dispose();
  });

  it("posts changes, additions and removals together, each against the bag before", () => {
    const bridge = new RenderBridge();
    const worker = FakeWorker.instances[0];
    bridge.setContributedParams(bagOf());
    bridge.setContributedParams({ "a.gain": 5, "c.mix": 3 });
    bridge.setContributedParams({ "a.gain": 1, "c.mix": 3 });

    const [second, third] = patches(worker);
    expect(second.set).toEqual({ "a.gain": 5, "c.mix": 3 });
    expect([...second.remove].sort()).toEqual(["a.cov", "b.take"]);
    expect(third).toEqual({ cmd: "patchContributedParams", set: { "a.gain": 1 }, remove: [] });
    bridge.dispose();
  });

  // The renderer reads `bag[key] ?? default`, so undefined and absent look alike there,
  // but a whole post would carry the key. A key present with `undefined` is an entry like
  // any other: set when it appears or turns undefined, removed when dropped. (`toEqual`
  // ignores undefined properties, so these compare strictly.)
  describe("with an undefined value", () => {
    const patchesAfter = (...bags: Record<string, unknown>[]) => {
      const bridge = new RenderBridge();
      for (const bag of bags) bridge.setContributedParams(bag);
      bridge.dispose();
      return patches(FakeWorker.instances[0]);
    };

    it("posts a value that turned undefined as a set, not a removal", () => {
      expect(patchesAfter({ "a.opt": 1 }, { "a.opt": undefined })).toStrictEqual([
        { cmd: "patchContributedParams", set: { "a.opt": undefined }, remove: [] },
      ]);
    });

    it("posts a key that appeared holding undefined as a set", () => {
      expect(patchesAfter({}, { "a.opt": undefined })).toStrictEqual([
        { cmd: "patchContributedParams", set: { "a.opt": undefined }, remove: [] },
      ]);
    });

    it("posts a dropped key that held undefined as a removal", () => {
      expect(patchesAfter({ "a.opt": undefined }, {})).toStrictEqual([
        { cmd: "patchContributedParams", set: {}, remove: ["a.opt"] },
      ]);
    });

    it("posts nothing while a key keeps holding undefined", () => {
      expect(patchesAfter({ "a.opt": undefined }, { "a.opt": undefined })).toStrictEqual([]);
    });
  });

  it("posts the bag whole again once init is posted again", () => {
    const bridge = new RenderBridge();
    const worker = FakeWorker.instances[0];
    bridge.init(64, 64);
    const bag = bagOf();
    bridge.setContributedParams(bag);
    bridge.setContributedParams(bag);
    expect(bagPosts(worker)).toHaveLength(1);

    bridge.init(64, 64);
    bridge.setContributedParams(bag);
    bridge.setContributedParams(bag);
    expect(bagPosts(worker).map((m) => m.cmd)).toEqual([
      "setContributedParams",
      "setContributedParams",
    ]);
    expect(wholes(worker)[1].bag).toBe(bag);

    bridge.setContributedParams({ ...bag, "a.gain": 2 });
    expect(patches(worker)).toHaveLength(1);
    bridge.dispose();
  });

  // A value the worker can't be sent (a function, say) fails the post. The bag must not
  // then be taken for posted, or the failure would pass silently from the next frame on.
  it("does not count a bag as posted when posting it failed", () => {
    const bridge = new RenderBridge();
    const worker = FakeWorker.instances[0];
    const bag = bagOf();
    vi.spyOn(worker, "postMessage").mockImplementationOnce(() => {
      throw new DOMException("could not be cloned", "DataCloneError");
    });
    expect(() => bridge.setContributedParams(bag)).toThrow("could not be cloned");
    bridge.setContributedParams(bag);
    expect(wholes(worker)).toHaveLength(1);
    expect(wholes(worker)[0].bag).toBe(bag);
    bridge.dispose();
  });

  it("posts the bag whole again once a failed init is retried", () => {
    const bridge = new RenderBridge();
    bridge.setOnError(() => undefined);
    const worker = FakeWorker.instances[0];
    bridge.init(64, 64);
    const bag = bagOf();
    bridge.setContributedParams(bag);
    worker.reply(initError);
    vi.advanceTimersByTime(1_000);
    expect(inits(worker)).toHaveLength(2);
    bridge.setContributedParams(bag);
    bridge.setContributedParams(bag);
    expect(wholes(worker)).toHaveLength(2);
    expect(patches(worker)).toHaveLength(0);
    bridge.dispose();
  });
});

describe("RenderBridge image hand-off", () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const cachedPreview = () => ({
    kind: "float16" as const,
    data: new Uint16Array(4),
    width: 1,
    height: 1,
  });

  // A cached develop preview runs to tens of megabytes; it must move to the
  // worker rather than be copied on every open.
  it("transfers a cached float16 source's pixels to the worker", () => {
    const bridge = new RenderBridge();
    const worker = FakeWorker.instances[0];
    const transferOf = (cmd: WorkerRequest["cmd"]) =>
      worker.transfers[worker.posted.findIndex((m) => m.cmd === cmd)];

    const shown = cachedPreview();
    const uploaded = cachedPreview();
    const thumb = cachedPreview();
    bridge.setImage(shown);
    bridge.uploadSource("main", "k", uploaded);
    bridge.renderThumbnail({
      requestId: "t",
      image: thumb,
      params: normalizeParams({}),
      asShotTemperature: 5000,
      maxEdge: 256,
    });

    expect(transferOf("setImage")).toEqual([shown.data.buffer]);
    expect(transferOf("uploadSource")).toEqual([uploaded.data.buffer]);
    expect(transferOf("renderThumbnail")).toEqual([thumb.data.buffer]);
    bridge.dispose();
  });
});

// The worker builds its first develop program while it handles `init`, from the
// stages and pipeline it holds by then. So the bridge posts the current ones just
// ahead of `init`: on the first, and on every retry, since either may have changed
// while an init was failing.
describe("RenderBridge startup messages", () => {
  const stage = (id: string): ProcessingStageContribution => ({
    id,
    name: id,
    phase: "effects",
    glsl: "c = c;",
    uniforms: [],
  });
  const AGX = {
    id: "test.agx",
    name: "AgX",
    glsl: "vec3 pipelineToDisplay(vec3 lin) { return lin; }",
  };

  beforeEach(() => {
    vi.useFakeTimers();
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
    useRegistry.setState({ pipelines: {} });
    registerPipeline("core", { id: DEFAULT_PIPELINE, name: "Built-in" });
    registerPipeline("test", AGX);
    registerProcessingStage("test", stage("test.first"));
    usePipelineStore.setState({ activeId: DEFAULT_PIPELINE });
  });

  afterEach(() => {
    disposeRenderBridge();
    unregisterProcessingStage("test", "test.first");
    unregisterProcessingStage("test", "test.second");
    useRegistry.setState({ pipelines: {} });
    usePipelineStore.setState({ activeId: DEFAULT_PIPELINE });
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  type Startup = Extract<WorkerRequest, { cmd: "setStages" | "setPipeline" | "init" }>;
  const STARTUP: ReadonlySet<string> = new Set(["setStages", "setPipeline", "init"]);
  const startup = (worker: FakeWorker) =>
    worker.posted.filter((m): m is Startup => STARTUP.has(m.cmd));
  const stageIds = (m: Startup) => (m.cmd === "setStages" ? m.stages.map((s) => s.id) : []);
  const pipelineId = (m: Startup) => (m.cmd === "setPipeline" ? m.pipeline.id : "");

  it("posts the registered stages and the live pipeline ahead of init", () => {
    const bridge = new RenderBridge();
    bridge.init(64, 64);
    const posts = startup(FakeWorker.instances[0]);
    expect(posts.map((m) => m.cmd)).toEqual(["setStages", "setPipeline", "init"]);
    expect(stageIds(posts[0])).toEqual(["test.first"]);
    expect(pipelineId(posts[1])).toBe(DEFAULT_PIPELINE);
    bridge.dispose();
  });

  it("posts them again, as they stand then, ahead of every retry", () => {
    const bridge = new RenderBridge();
    bridge.setOnError(() => undefined);
    bridge.init(64, 64);
    const worker = FakeWorker.instances[0];

    // While the first init fails, a stage is registered and the photo picks a transform.
    registerProcessingStage("test", stage("test.second"));
    bridge.setParams(normalizeParams({ displayTransform: AGX.id }));
    worker.reply(initError);
    vi.advanceTimersByTime(1_000);

    const retry = startup(worker).slice(-3);
    expect(retry.map((m) => m.cmd)).toEqual(["setStages", "setPipeline", "init"]);
    expect(stageIds(retry[0])).toEqual(["test.first", "test.second"]);
    expect(pipelineId(retry[1])).toBe(AGX.id);

    worker.reply(initError);
    vi.advanceTimersByTime(2_000);
    const again = startup(worker).slice(-3);
    expect(again.map((m) => m.cmd)).toEqual(["setStages", "setPipeline", "init"]);
    expect(inits(worker)).toHaveLength(3);
    bridge.dispose();
  });

  it("starts the shared bridge with one post of each, ahead of init", () => {
    getRenderBridge();
    expect(startup(FakeWorker.instances[0]).map((m) => m.cmd)).toEqual([
      "setStages",
      "setPipeline",
      "init",
    ]);
  });

  it("still sends the stages and the pipeline when the registry changes afterwards", () => {
    getRenderBridge();
    const worker = FakeWorker.instances[0];
    const atStart = startup(worker).length;
    registerProcessingStage("test", stage("test.second"));
    registerPipeline("test", { ...AGX, id: "test.agx2" });
    const later = startup(worker).slice(atStart);
    expect(later.map((m) => m.cmd)).toEqual(["setStages", "setPipeline"]);
    expect(stageIds(later[0])).toEqual(["test.first", "test.second"]);
  });
});
