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
import {
  RenderBridge,
  disposeRenderBridge,
  getRenderBridge,
  getStageTextures,
  setStageTexture,
  type FrameResult,
  type ThumbnailResult,
} from "./render-bridge";
import type { HistogramData } from "./histogram";
import type { UprightResult } from "./upright";
import type { WorkerRequest, WorkerResponse } from "./render-worker";
import {
  defaultMaskAdjustments,
  normalizeParams,
  type DevelopParams,
  type Mask,
  type RetouchSpot,
} from "@/catalog/types";
import {
  registerPipeline,
  registerProcessingStage,
  unregisterExtension,
  unregisterProcessingStage,
  useRegistry,
} from "@/extensions/registry";
import { DEFAULT_PIPELINE, usePipelineStore } from "@/extensions/pipelines";
import type { ProcessingStageContribution, StageTextureData } from "@/extensions/types";

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
  const patched = (worker: FakeWorker) =>
    worker.posted.flatMap((m) => (m.cmd === "patchParams" ? [m.set] : []));

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
    expect(posted(worker)).toEqual([first]);
    expect(patched(worker)).toStrictEqual([{ exposure: 1 }, { exposure: first.exposure }]);
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

// Each changed slider tick posted the whole params, and the structured clone gave the
// worker new masks and retouch arrays every time, so its renderer signed every brush dab
// again on every tick. After the first params, and the first after each init, only the
// top-level fields that are not the same value as in the params posted last go, as a
// patch the worker merges into the params it holds.
describe("RenderBridge params patches", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  type Whole = Extract<WorkerRequest, { cmd: "setParams" }>;
  type Patch = Extract<WorkerRequest, { cmd: "patchParams" }>;
  const paramsPosts = (worker: FakeWorker) =>
    worker.posted.filter(
      (m): m is Whole | Patch => m.cmd === "setParams" || m.cmd === "patchParams",
    );
  const patches = (worker: FakeWorker) =>
    worker.posted.filter((m): m is Patch => m.cmd === "patchParams");
  const cmds = (worker: FakeWorker) => paramsPosts(worker).map((m) => m.cmd);
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
    ...normalizeParams({}),
    masks: [mask("m1")],
    retouch: [spot("s1")],
  });
  const cloneFailsOnce = (worker: FakeWorker) =>
    vi.spyOn(worker, "postMessage").mockImplementationOnce(() => {
      throw new DOMException("could not be cloned", "DataCloneError");
    });

  it("posts an exposure tick as a patch of exposure alone, without the masks or retouch", () => {
    const bridge = new RenderBridge();
    const worker = FakeWorker.instances[0];
    const base = painted();
    bridge.setParams(base);
    bridge.setParams({ ...base, exposure: 1 });

    expect(cmds(worker)).toEqual(["setParams", "patchParams"]);
    expect(patches(worker)).toStrictEqual([
      { cmd: "patchParams", set: { exposure: 1 }, remove: [] },
    ]);
    bridge.dispose();
  });

  it("posts a field that was replaced as the very value it was handed", () => {
    const bridge = new RenderBridge();
    const worker = FakeWorker.instances[0];
    const base = painted();
    const masks = [mask("m1"), mask("m2")];
    bridge.setParams(base);
    bridge.setParams({ ...base, masks });

    const [patch] = patches(worker);
    expect(Object.keys(patch.set)).toEqual(["masks"]);
    expect(patch.set.masks).toBe(masks);
    bridge.dispose();
  });

  it("posts nothing for another object holding the same values", () => {
    const bridge = new RenderBridge();
    const worker = FakeWorker.instances[0];
    const base = painted();
    bridge.setParams(base);
    bridge.setParams({ ...base });
    expect(cmds(worker)).toEqual(["setParams"]);
    bridge.dispose();
  });

  it("posts a key the params dropped as a removal, and one that came back as a set", () => {
    const bridge = new RenderBridge();
    const worker = FakeWorker.instances[0];
    const base = painted();
    const fromOlderEdit = { ...base, lensProfile: "legacy" };
    bridge.setParams(fromOlderEdit);
    bridge.setParams(base);
    bridge.setParams(fromOlderEdit);

    expect(patches(worker)).toStrictEqual([
      { cmd: "patchParams", set: {}, remove: ["lensProfile"] },
      { cmd: "patchParams", set: { lensProfile: "legacy" }, remove: [] },
    ]);
    bridge.dispose();
  });

  it("posts the first params after init whole, not as a patch on the ones before it", () => {
    const bridge = new RenderBridge();
    const worker = FakeWorker.instances[0];
    bridge.init(64, 64);
    const base = painted();
    bridge.setParams(base);
    bridge.setParams({ ...base, exposure: 1 });

    bridge.init(64, 64);
    const after = { ...base, exposure: 2 };
    bridge.setParams(after);
    bridge.setParams({ ...after, contrast: 5 });

    expect(cmds(worker)).toEqual(["setParams", "patchParams", "setParams", "patchParams"]);
    expect(paramsPosts(worker)[2]).toStrictEqual({ cmd: "setParams", params: after });
    expect(patches(worker)[1].set).toStrictEqual({ contrast: 5 });
    bridge.dispose();
  });

  it("posts the first params after a failed init is retried whole", () => {
    const bridge = new RenderBridge();
    bridge.setOnError(() => undefined);
    const worker = FakeWorker.instances[0];
    bridge.init(64, 64);
    const base = painted();
    bridge.setParams(base);
    worker.reply(initError);
    bridge.setParams({ ...base, exposure: 1 });
    vi.advanceTimersByTime(1_000);
    expect(inits(worker)).toHaveLength(2);

    const after = { ...base, exposure: 2 };
    bridge.setParams(after);
    expect(cmds(worker)).toEqual(["setParams", "patchParams", "setParams"]);
    expect(paramsPosts(worker)[2]).toStrictEqual({ cmd: "setParams", params: after });
    bridge.dispose();
  });

  // The worker can only merge a patch into params it holds. Params whose post failed
  // never reached it, so the next ones go whole.
  it("posts whole again after the whole post failed, never a patch", () => {
    const bridge = new RenderBridge();
    const worker = FakeWorker.instances[0];
    bridge.init(64, 64);
    const base = painted();
    cloneFailsOnce(worker);
    expect(() => bridge.setParams(base)).toThrow("could not be cloned");

    const next = { ...base, exposure: 1 };
    bridge.setParams(next);
    expect(cmds(worker)).toEqual(["setParams"]);
    expect(paramsPosts(worker)[0]).toStrictEqual({ cmd: "setParams", params: next });
    bridge.dispose();
  });

  it("patches against the params last posted when a patch's post failed", () => {
    const bridge = new RenderBridge();
    const worker = FakeWorker.instances[0];
    bridge.init(64, 64);
    const base = painted();
    bridge.setParams(base);
    cloneFailsOnce(worker);
    expect(() => bridge.setParams({ ...base, exposure: 1 })).toThrow("could not be cloned");

    bridge.setParams({ ...base, exposure: 1, contrast: 5 });
    expect(patches(worker)).toStrictEqual([
      { cmd: "patchParams", set: { exposure: 1, contrast: 5 }, remove: [] },
    ]);
    bridge.dispose();
  });

  it("captures with whole params, and patches the live params against the ones before", () => {
    const bridge = new RenderBridge();
    const worker = FakeWorker.instances[0];
    const base = painted();
    const before = { ...base, exposure: -1 };
    bridge.setParams(base);
    void bridge.capture(before);
    bridge.setParams({ ...base, contrast: 5 });

    type Capture = Extract<WorkerRequest, { cmd: "capture" }>;
    const captures = worker.posted.filter((m): m is Capture => m.cmd === "capture");
    expect(captures.map((m) => m.params)).toEqual([before]);
    expect(captures[0].params).toBe(before);
    expect(patches(worker)).toStrictEqual([
      { cmd: "patchParams", set: { contrast: 5 }, remove: [] },
    ]);
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

// Stage textures are bulk pixel data (film LUTs, spectral tables) kept for as
// long as their stage can use them. Turning the extension that owns the stage
// off must hand them back, here and in the worker, not at the next restart.
describe("stage textures of an extension that is turned off", () => {
  const stage = (id: string): ProcessingStageContribution => ({
    id,
    name: id,
    phase: "effects",
    glsl: "c = c;",
    uniforms: [],
  });
  const texture = (version: number): StageTextureData => ({
    data: new Uint8Array([0, 0, 0, 255]),
    width: 1,
    height: 1,
    format: "rgba8",
    version,
  });
  const lastBag = (worker: FakeWorker) =>
    worker.posted.filter((m) => m.cmd === "setStageTextures").at(-1);

  beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
    useRegistry.setState({ processingStages: {} });
  });

  afterEach(() => {
    for (const key of Object.keys(getStageTextures())) setStageTexture(key, null);
    disposeRenderBridge();
    useRegistry.setState({ processingStages: {} });
    vi.unstubAllGlobals();
  });

  it("drops them from the bag and sends the worker the smaller bag", () => {
    getRenderBridge();
    const worker = FakeWorker.instances[0];
    registerProcessingStage("acme.film", stage("acme.film.grade"));
    registerProcessingStage("acme.tone", stage("acme.tone.curve"));
    setStageTexture("acme.film.grade.lut", texture(1));
    setStageTexture("acme.film.grade.spectra", texture(1));
    setStageTexture("acme.tone.curve.lut", texture(1));

    unregisterExtension("acme.film");

    expect(Object.keys(getStageTextures())).toEqual(["acme.tone.curve.lut"]);
    expect(lastBag(worker)).toEqual({
      cmd: "setStageTextures",
      bag: { "acme.tone.curve.lut": texture(1) },
    });
  });

  it("keeps a texture of another extension's stage whose id extends a dropped one", () => {
    registerProcessingStage("acme.film", stage("acme.film"));
    registerProcessingStage("acme.extra", stage("acme.film.extra"));
    setStageTexture("acme.film.lut", texture(1));
    setStageTexture("acme.film.extra.lut", texture(1));

    unregisterExtension("acme.film");

    expect(Object.keys(getStageTextures())).toEqual(["acme.film.extra.lut"]);
  });
});

// What the bridge settles or calls for each reply the worker can send. A request
// and its reply pair by `reqId` (`requestId` for thumbnails), so replies may come
// back in any order and none may settle another request's promise.
describe("RenderBridge worker replies", () => {
  type Sent<C extends WorkerRequest["cmd"]> = Extract<WorkerRequest, { cmd: C }>;
  const sent = <C extends WorkerRequest["cmd"]>(w: FakeWorker, cmd: C) =>
    w.posted.filter((m): m is Sent<C> => m.cmd === cmd);

  interface Outcome<T> {
    state: "pending" | "resolved" | "rejected";
    value?: T;
    reason?: unknown;
  }
  function track<T>(promise: Promise<T>): Outcome<T> {
    const outcome: Outcome<T> = { state: "pending" };
    void promise.then(
      (value) => {
        outcome.state = "resolved";
        outcome.value = value;
      },
      (reason: unknown) => {
        outcome.state = "rejected";
        outcome.reason = reason;
      },
    );
    return outcome;
  }
  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  const bitmapOf = (width: number): ImageBitmap => ({ width, height: 3, close: () => undefined });
  const histogramOf = (peak: number): HistogramData => {
    const bins = () => {
      const counts = new Uint32Array(256);
      counts[128] = peak;
      return counts;
    };
    return { r: bins(), g: bins(), b: bins(), luma: bins() };
  };
  const levelled: UprightResult = {
    straighten: -1.5,
    perspectiveV: 12,
    perspectiveH: -7,
    aspect: 1.4,
  };
  const noop: UprightResult = { straighten: 0, perspectiveV: 0, perspectiveH: 0 };
  const params = normalizeParams({});
  const thumbRequest = (requestId: string) => ({
    requestId,
    image: { kind: "float16" as const, data: new Uint16Array(4), width: 1, height: 1 },
    params,
    asShotTemperature: 5000,
    maxEdge: 256,
  });
  const sourceRequest = (requestId: string) => ({
    requestId,
    key: "k",
    params,
    asShotTemperature: 5000,
    maxEdge: 256,
  });

  let bridge: RenderBridge;
  let worker: FakeWorker;

  beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
    bridge = new RenderBridge();
    worker = FakeWorker.instances[0];
  });

  afterEach(() => {
    bridge.dispose();
    vi.unstubAllGlobals();
  });

  describe("frame and histogram", () => {
    it("hands a frame's bitmap, size, source and histogram to onFrame", () => {
      const onFrame = vi.fn<(frame: FrameResult) => void>();
      bridge.setOnFrame(onFrame);
      const bitmap = bitmapOf(640);
      const histogram = histogramOf(9);
      worker.reply({
        type: "frame",
        seq: 1,
        bitmap,
        width: 640,
        height: 480,
        sourceWidth: 4096,
        sourceHeight: 2731,
        sourceGen: 3,
        histogram,
      });

      expect(onFrame).toHaveBeenCalledTimes(1);
      const [frame] = onFrame.mock.calls[0];
      expect(frame.bitmap).toBe(bitmap);
      expect(frame.width).toBe(640);
      expect(frame.height).toBe(480);
      expect(frame).toMatchObject({ sourceWidth: 4096, sourceHeight: 2731, sourceGen: 3 });
      expect(frame.histogram).toBe(histogram);
    });

    it("hands over a frame that carries no histogram with none", () => {
      const onFrame = vi.fn<(frame: FrameResult) => void>();
      bridge.setOnFrame(onFrame);
      const bitmap = bitmapOf(320);
      worker.reply({
        type: "frame",
        seq: 1,
        bitmap,
        width: 320,
        height: 240,
        sourceWidth: 320,
        sourceHeight: 240,
        sourceGen: 1,
      });

      expect(onFrame).toHaveBeenCalledTimes(1);
      expect(onFrame.mock.calls[0][0].bitmap).toBe(bitmap);
      expect(onFrame.mock.calls[0][0].histogram).toBeUndefined();
    });

    it("hands a histogram reply to onHistogram, the very object it carried", () => {
      const onHistogram = vi.fn<(histogram: HistogramData) => void>();
      const onFrame = vi.fn<(frame: FrameResult) => void>();
      bridge.setOnHistogram(onHistogram);
      bridge.setOnFrame(onFrame);
      const histogram = histogramOf(4);
      worker.reply({ type: "histogram", histogram });

      expect(onHistogram).toHaveBeenCalledTimes(1);
      expect(onHistogram.mock.calls[0][0]).toBe(histogram);
      expect(onFrame).not.toHaveBeenCalled();
    });

    it("drops replies while no callback is set, and once a callback is cleared", () => {
      const onFrame = vi.fn<(frame: FrameResult) => void>();
      bridge.setOnFrame(onFrame);
      bridge.setOnFrame(null);
      expect(() => {
        worker.reply({
          type: "frame",
          seq: 1,
          bitmap: bitmapOf(8),
          width: 8,
          height: 3,
          sourceWidth: 8,
          sourceHeight: 3,
          sourceGen: 1,
        });
        worker.reply({ type: "histogram", histogram: histogramOf(1) });
        worker.reply({ type: "thumbnail", requestId: "none", blob: new Blob(["x"]) });
        worker.reply({ type: "upright", reqId: 999, result: levelled });
        worker.reply({ type: "healSource", data: new Uint8ClampedArray(4), width: 1, height: 1 });
        worker.reply({ type: "error", message: "nobody listens" });
      }).not.toThrow();
      expect(onFrame).not.toHaveBeenCalled();
    });

    // A frame's bitmap holds a decoded image until closed. One that comes while no
    // view listens (Develop closed, or between one photo's view and the next's)
    // would hold it until garbage collection.
    it("closes a frame that comes while no callback is set", () => {
      const close = vi.fn();
      worker.reply({
        type: "frame",
        seq: 1,
        bitmap: { width: 8, height: 3, close },
        width: 8,
        height: 3,
        sourceWidth: 8,
        sourceHeight: 3,
        sourceGen: 1,
      });
      expect(close).toHaveBeenCalledTimes(1);
    });

    it("leaves closing a frame it hands to onFrame to the callback", () => {
      const close = vi.fn();
      bridge.setOnFrame(() => {});
      worker.reply({
        type: "frame",
        seq: 1,
        bitmap: { width: 8, height: 3, close },
        width: 8,
        height: 3,
        sourceWidth: 8,
        sourceHeight: 3,
        sourceGen: 1,
      });
      expect(close).not.toHaveBeenCalled();
    });
  });

  describe("thumbnails", () => {
    it("resolves renderThumbnailAsync with the blob and calls onThumbnail", async () => {
      const onThumbnail = vi.fn<(result: ThumbnailResult) => void>();
      bridge.setOnThumbnail(onThumbnail);
      const blob = new Blob(["jpeg"]);
      const outcome = track(bridge.renderThumbnailAsync(thumbRequest("t1")));
      expect(sent(worker, "renderThumbnail").map((m) => m.requestId)).toEqual(["t1"]);
      expect(outcome.state).toBe("pending");

      worker.reply({ type: "thumbnail", requestId: "t1", blob });
      await flush();

      expect(outcome.state).toBe("resolved");
      expect(outcome.value).toBe(blob);
      expect(onThumbnail).toHaveBeenCalledTimes(1);
      expect(onThumbnail.mock.calls[0][0].requestId).toBe("t1");
      expect(onThumbnail.mock.calls[0][0].blob).toBe(blob);
    });

    it("resolves renderThumbnailFromSource with the blob and calls onThumbnail", async () => {
      const onThumbnail = vi.fn<(result: ThumbnailResult) => void>();
      bridge.setOnThumbnail(onThumbnail);
      const blob = new Blob(["jpeg"]);
      const outcome = track(bridge.renderThumbnailFromSource(sourceRequest("s1")));
      worker.reply({ type: "thumbnail", requestId: "s1", blob });
      await flush();

      expect(outcome.state).toBe("resolved");
      expect(outcome.value).toBe(blob);
      expect(onThumbnail).toHaveBeenCalledTimes(1);
      expect(onThumbnail.mock.calls[0][0].requestId).toBe("s1");
    });

    it("settles each thumbnail by its requestId, whatever order the replies come in", async () => {
      const first = new Blob(["one"]);
      const second = new Blob(["two"]);
      const a = track(bridge.renderThumbnailFromSource(sourceRequest("a")));
      const b = track(bridge.renderThumbnailAsync(thumbRequest("b")));

      worker.reply({ type: "thumbnail", requestId: "b", blob: second });
      await flush();
      expect(b.state).toBe("resolved");
      expect(b.value).toBe(second);
      expect(a.state).toBe("pending");

      worker.reply({ type: "thumbnail", requestId: "a", blob: first });
      await flush();
      expect(a.state).toBe("resolved");
      expect(a.value).toBe(first);
    });

    it("resolves a cache miss with null, without a thumbnail or an error", async () => {
      const onThumbnail = vi.fn<(result: ThumbnailResult) => void>();
      const onError = vi.fn<(message: string) => void>();
      bridge.setOnThumbnail(onThumbnail);
      bridge.setOnError(onError);
      const other = track(bridge.renderThumbnailFromSource(sourceRequest("other")));
      const outcome = track(bridge.renderThumbnailFromSource(sourceRequest("s1")));

      worker.reply({ type: "thumbnailMiss", requestId: "s1", key: "k" });
      await flush();

      expect(outcome.state).toBe("resolved");
      expect(outcome.value).toBeNull();
      expect(other.state).toBe("pending");
      expect(onThumbnail).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    });

    it("rejects renderThumbnailAsync and reports the cause on a thumbnailError", async () => {
      const onThumbnail = vi.fn<(result: ThumbnailResult) => void>();
      const onError = vi.fn<(message: string) => void>();
      bridge.setOnThumbnail(onThumbnail);
      bridge.setOnError(onError);
      const other = track(bridge.renderThumbnailAsync(thumbRequest("other")));
      const outcome = track(bridge.renderThumbnailAsync(thumbRequest("t1")));

      worker.reply({ type: "thumbnailError", requestId: "t1", message: "convertToBlob rejected" });
      await flush();

      expect(outcome.state).toBe("rejected");
      expect(outcome.reason).toMatchObject({ message: "thumbnail render failed" });
      expect(other.state).toBe("pending");
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith("thumbnail render failed: convertToBlob rejected");
      expect(onThumbnail).not.toHaveBeenCalled();
    });

    it("resolves a from-source thumbnail with null on a thumbnailError", async () => {
      bridge.setOnError(() => undefined);
      const outcome = track(bridge.renderThumbnailFromSource(sourceRequest("s1")));
      worker.reply({ type: "thumbnailError", requestId: "s1", message: "lost context" });
      await flush();

      expect(outcome.state).toBe("resolved");
      expect(outcome.value).toBeNull();
    });
  });

  describe("source cache", () => {
    it("settles bindSource with the reply's hit flag", async () => {
      const hit = track(bridge.bindSource("warm"));
      const miss = track(bridge.bindSource("cold"));
      const [warm, cold] = sent(worker, "bindSource");
      expect([warm.key, cold.key]).toEqual(["warm", "cold"]);

      worker.reply({ type: "sourceBound", reqId: warm.reqId, hit: true });
      worker.reply({ type: "sourceBound", reqId: cold.reqId, hit: false });
      await flush();

      expect(hit.value).toBe(true);
      expect(miss.value).toBe(false);
    });

    it("settles bindSource by reqId when the replies come back out of order", async () => {
      const first = track(bridge.bindSource("one"));
      const second = track(bridge.bindSource("two"));
      const third = track(bridge.bindSource("three"));
      const [one, two, three] = sent(worker, "bindSource");

      worker.reply({ type: "sourceBound", reqId: three.reqId, hit: false });
      await flush();
      expect([first.state, second.state, third.state]).toEqual(["pending", "pending", "resolved"]);
      expect(third.value).toBe(false);

      worker.reply({ type: "sourceBound", reqId: one.reqId, hit: true });
      await flush();
      expect([first.state, second.state]).toEqual(["resolved", "pending"]);
      expect(first.value).toBe(true);

      worker.reply({ type: "sourceBound", reqId: two.reqId, hit: true });
      await flush();
      expect(second.state).toBe("resolved");
      expect(second.value).toBe(true);
    });

    it("settles hasSource with the reply's has flag", async () => {
      const resident = track(bridge.hasSource("main", "warm"));
      const absent = track(bridge.hasSource("thumb", "cold"));
      const [warm, cold] = sent(worker, "hasSource");
      expect([warm.target, warm.key, cold.target, cold.key]).toEqual([
        "main",
        "warm",
        "thumb",
        "cold",
      ]);

      worker.reply({ type: "hasSource", reqId: warm.reqId, has: true });
      worker.reply({ type: "hasSource", reqId: cold.reqId, has: false });
      await flush();

      expect(resident.value).toBe(true);
      expect(absent.value).toBe(false);
    });

    it("settles hasSource by reqId when the replies come back out of order", async () => {
      const first = track(bridge.hasSource("main", "one"));
      const second = track(bridge.hasSource("main", "two"));
      const [one, two] = sent(worker, "hasSource");

      worker.reply({ type: "hasSource", reqId: two.reqId, has: true });
      await flush();
      expect([first.state, second.state]).toEqual(["pending", "resolved"]);
      expect(second.value).toBe(true);

      worker.reply({ type: "hasSource", reqId: one.reqId, has: false });
      await flush();
      expect(first.state).toBe("resolved");
      expect(first.value).toBe(false);
    });

    // The worker numbers the develop renderer's sources by the same messages, and its
    // frames carry the number (render-worker.ts, sourceGen).
    it("counts each develop source it hands over, as the worker numbers them", async () => {
      const image = () => ({
        kind: "float16" as const,
        data: new Uint16Array(4),
        width: 1,
        height: 1,
      });
      expect(bridge.sourceGen).toBe(0);
      bridge.setImage(image());
      expect(bridge.sourceGen).toBe(1);
      bridge.uploadSource("main", "a", image());
      expect(bridge.sourceGen).toBe(2);
      bridge.uploadSource("main", "b", image(), undefined, false, false, false);
      bridge.uploadSource("thumb", "c", image());
      expect(bridge.sourceGen).toBe(2);

      const miss = track(bridge.bindSource("gone"));
      const hit = track(bridge.bindSource("a"));
      const [gone, a] = sent(worker, "bindSource");
      expect(bridge.sourceGen).toBe(2);
      worker.reply({ type: "sourceBound", reqId: gone.reqId, hit: false });
      worker.reply({ type: "sourceBound", reqId: a.reqId, hit: true });
      await flush();
      expect([miss.value, hit.value]).toEqual([false, true]);
      expect(bridge.sourceGen).toBe(3);
    });

    // A count one ahead of the worker's would leave every later photo's frames
    // numbered below the source it settled on.
    const tiny = () => ({
      kind: "float16" as const,
      data: new Uint16Array(4),
      width: 1,
      height: 1,
    });
    const handOver: [string, (b: RenderBridge) => void][] = [
      ["setImage", (b) => b.setImage(tiny())],
      ["uploadSource", (b) => b.uploadSource("main", "a", tiny())],
    ];
    it.each(handOver)("counts no source that %s could not send", (_label, send) => {
      vi.spyOn(worker, "postMessage").mockImplementationOnce(() => {
        throw new DOMException("could not be cloned", "DataCloneError");
      });

      expect(() => send(bridge)).toThrow("could not be cloned");
      expect(bridge.sourceGen).toBe(0);

      send(bridge);
      expect(bridge.sourceGen).toBe(1);
    });
  });

  describe("capture", () => {
    it("resolves capture with the captured bitmap, matched by reqId", async () => {
      const first = track(bridge.capture(params));
      const second = track(bridge.capture(params));
      const [one, two] = sent(worker, "capture");
      const bitmapOne = bitmapOf(10);
      const bitmapTwo = bitmapOf(20);

      worker.reply({ type: "captured", reqId: two.reqId, bitmap: bitmapTwo });
      await flush();
      expect([first.state, second.state]).toEqual(["pending", "resolved"]);
      expect(second.value).toBe(bitmapTwo);

      worker.reply({ type: "captured", reqId: one.reqId, bitmap: bitmapOne });
      await flush();
      expect(first.state).toBe("resolved");
      expect(first.value).toBe(bitmapOne);
    });
  });

  describe("upright", () => {
    it("resolves computeUpright with the result and calls onUpright", async () => {
      const onUpright = vi.fn<(result: UprightResult) => void>();
      bridge.setOnUpright(onUpright);
      const outcome = track(bridge.computeUpright("full"));
      const [request] = sent(worker, "analyzeUpright");
      expect(request.mode).toBe("full");

      worker.reply({ type: "upright", reqId: request.reqId, result: levelled });
      await flush();

      expect(outcome.state).toBe("resolved");
      expect(outcome.value).toBe(levelled);
      expect(onUpright).toHaveBeenCalledTimes(1);
      expect(onUpright.mock.calls[0][0]).toBe(levelled);
    });

    it("settles each analysis by its reqId, whatever order the replies come in", async () => {
      const level = track(bridge.computeUpright("level"));
      const vertical = track(bridge.computeUpright("vertical"));
      const [levelRequest, verticalRequest] = sent(worker, "analyzeUpright");
      const verticalResult: UprightResult = { straighten: 0, perspectiveV: 30, perspectiveH: 0 };

      worker.reply({ type: "upright", reqId: verticalRequest.reqId, result: verticalResult });
      await flush();
      expect([level.state, vertical.state]).toEqual(["pending", "resolved"]);
      expect(vertical.value).toBe(verticalResult);

      worker.reply({ type: "upright", reqId: levelRequest.reqId, result: levelled });
      await flush();
      expect(level.state).toBe("resolved");
      expect(level.value).toBe(levelled);
    });

    it("settles computeUpright with a no-op result on an uprightError, and reports it", async () => {
      const onError = vi.fn<(message: string) => void>();
      bridge.setOnError(onError);
      const other = track(bridge.computeUpright("level"));
      const outcome = track(bridge.computeUpright("auto"));
      const [, request] = sent(worker, "analyzeUpright");

      worker.reply({ type: "uprightError", reqId: request.reqId, message: "no edges found" });
      await flush();

      expect(outcome.state).toBe("resolved");
      expect(outcome.value).toStrictEqual(noop);
      expect(other.state).toBe("pending");
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith("upright analysis failed: no edges found");
    });
  });

  describe("heal source, errors and the worker's own failure", () => {
    it("hands the heal source's pixels and size to onHealSource", () => {
      const onHealSource =
        vi.fn<(src: { data: Uint8ClampedArray; width: number; height: number }) => void>();
      bridge.setOnHealSource(onHealSource);
      const data = new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255]);
      worker.reply({ type: "healSource", data, width: 3, height: 1 });

      expect(onHealSource).toHaveBeenCalledTimes(1);
      const [src] = onHealSource.mock.calls[0];
      expect(src.data).toBe(data);
      expect(src.width).toBe(3);
      expect(src.height).toBe(1);
    });

    it("hands the number of a source the worker couldn't take to onSourceError, and reports it", () => {
      const onSourceError = vi.fn<(sourceGen: number) => void>();
      const onError = vi.fn<(message: string) => void>();
      bridge.setOnSourceError(onSourceError);
      bridge.setOnError(onError);
      worker.reply({ type: "sourceError", sourceGen: 4, message: "texImage2D failed" });

      expect(onSourceError).toHaveBeenCalledTimes(1);
      expect(onSourceError).toHaveBeenCalledWith(4);
      expect(onError).toHaveBeenCalledWith("source failed: texImage2D failed");
    });

    it("reports an error reply's message to onError as it is", () => {
      const onError = vi.fn<(message: string) => void>();
      bridge.setOnError(onError);
      worker.reply({ type: "error", message: "render failed: out of memory" });

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith("render failed: out of memory");
    });

    it("reports the worker's own error event message to onError", () => {
      const onError = vi.fn<(message: string) => void>();
      bridge.setOnError(onError);
      worker.onerror?.(new ErrorEvent("error", { message: "Uncaught ReferenceError: x" }));

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith("Uncaught ReferenceError: x");
    });
  });

  describe("a reply nobody is waiting for", () => {
    it("settles no pending request, whichever kind of reply carries a stray reqId", async () => {
      const bind = track(bridge.bindSource("k"));
      const has = track(bridge.hasSource("main", "k"));
      const capture = track(bridge.capture(params));
      const upright = track(bridge.computeUpright("auto"));
      const ids = {
        bind: sent(worker, "bindSource")[0].reqId,
        has: sent(worker, "hasSource")[0].reqId,
        capture: sent(worker, "capture")[0].reqId,
        upright: sent(worker, "analyzeUpright")[0].reqId,
      };
      expect(new Set(Object.values(ids)).size).toBe(4);
      const pending = () => [bind.state, has.state, capture.state, upright.state];

      // Ids nobody issued, and each reply type carrying another kind's id.
      expect(() => {
        worker.reply({ type: "sourceBound", reqId: 999, hit: true });
        worker.reply({ type: "hasSource", reqId: 999, has: true });
        worker.reply({ type: "captured", reqId: 999, bitmap: bitmapOf(1) });
        worker.reply({ type: "upright", reqId: 999, result: levelled });
        worker.reply({ type: "sourceBound", reqId: ids.has, hit: true });
        worker.reply({ type: "hasSource", reqId: ids.capture, has: true });
        worker.reply({ type: "captured", reqId: ids.upright, bitmap: bitmapOf(1) });
        worker.reply({ type: "upright", reqId: ids.bind, result: levelled });
      }).not.toThrow();
      await flush();
      expect(pending()).toEqual(["pending", "pending", "pending", "pending"]);

      worker.reply({ type: "sourceBound", reqId: ids.bind, hit: true });
      worker.reply({ type: "hasSource", reqId: ids.has, has: true });
      worker.reply({ type: "captured", reqId: ids.capture, bitmap: bitmapOf(1) });
      worker.reply({ type: "upright", reqId: ids.upright, result: levelled });
      await flush();
      expect(pending()).toEqual(["resolved", "resolved", "resolved", "resolved"]);
    });

    it("settles no pending thumbnail for another requestId, yet reports a failure", async () => {
      const onError = vi.fn<(message: string) => void>();
      bridge.setOnError(onError);
      const direct = track(bridge.renderThumbnailAsync(thumbRequest("mine")));
      const fromSource = track(bridge.renderThumbnailFromSource(sourceRequest("yours")));

      worker.reply({ type: "thumbnail", requestId: "stray", blob: new Blob(["x"]) });
      worker.reply({ type: "thumbnailMiss", requestId: "stray", key: "k" });
      worker.reply({ type: "thumbnailError", requestId: "stray", message: "late failure" });
      await flush();

      expect([direct.state, fromSource.state]).toEqual(["pending", "pending"]);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith("thumbnail render failed: late failure");

      worker.reply({ type: "thumbnail", requestId: "mine", blob: new Blob(["m"]) });
      worker.reply({ type: "thumbnailMiss", requestId: "yours", key: "k" });
      await flush();
      expect([direct.state, fromSource.state]).toEqual(["resolved", "resolved"]);
    });

    it("settles no pending analysis for another reqId, and still reports a failure", async () => {
      const onError = vi.fn<(message: string) => void>();
      bridge.setOnError(onError);
      const outcome = track(bridge.computeUpright("auto"));
      const [request] = sent(worker, "analyzeUpright");

      worker.reply({ type: "uprightError", reqId: request.reqId + 100, message: "stale" });
      await flush();

      expect(outcome.state).toBe("pending");
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith("upright analysis failed: stale");

      worker.reply({ type: "upright", reqId: request.reqId, result: levelled });
      await flush();
      expect(outcome.state).toBe("resolved");
    });
  });
});

// The worker draws renders in the order they come, and the Develop view asks for one per
// animation frame. While each took longer than a frame a backlog built up, which the view
// kept playing back after the user let go of a slider. So one render is in flight at a
// time: the newest request waits, carrying every histogram the ones it replaced asked for,
// and goes when the worker answers the one in flight, however it answers. Messages that set
// state still go at once, so the worker has them before the render that waits.
describe("RenderBridge render mailbox", () => {
  type Render = Extract<WorkerRequest, { cmd: "render" }>;
  const renders = (w: FakeWorker) => w.posted.filter((m): m is Render => m.cmd === "render");
  /** The seq of the render posted last, which is the one in flight. */
  const inFlight = (w: FakeWorker) => {
    const last = renders(w).at(-1);
    if (!last) throw new Error("no render posted");
    return last.seq;
  };
  const frameFor = (seq: number): WorkerResponse => ({
    type: "frame",
    seq,
    bitmap: { width: 4, height: 3, close: () => undefined },
    width: 4,
    height: 3,
    sourceWidth: 4,
    sourceHeight: 3,
    sourceGen: 1,
  });
  const histograms = (w: FakeWorker) => w.posted.filter((m) => m.cmd === "computeHistogram");
  const spyWarn = () => vi.spyOn(console, "warn").mockImplementation(() => undefined);
  /** The worker has its renderer: init and the first program build are done. */
  const ready = (w: FakeWorker) => w.reply({ type: "ready", pipelineFloat: true });

  let bridge: RenderBridge;
  let worker: FakeWorker;
  let warn: ReturnType<typeof spyWarn>;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
    warn = spyWarn();
    bridge = new RenderBridge();
    worker = FakeWorker.instances[0];
  });

  afterEach(() => {
    bridge.dispose();
    warn.mockRestore();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("posts one render while another is in flight, then the newest once it is answered", () => {
    bridge.render();
    bridge.render();
    bridge.render();
    expect(renders(worker)).toHaveLength(1);

    worker.reply(frameFor(inFlight(worker)));
    expect(renders(worker)).toHaveLength(2);
    const [first, second] = renders(worker);
    expect(second.seq).not.toBe(first.seq);

    worker.reply(frameFor(inFlight(worker)));
    expect(renders(worker)).toHaveLength(2);
    bridge.render();
    expect(renders(worker)).toHaveLength(3);
  });

  it.each<[string, (seq: number) => WorkerResponse]>([
    ["frameSkipped", (seq) => ({ type: "frameSkipped", seq })],
    ["renderError", (seq) => ({ type: "renderError", seq, message: "lost context" })],
  ])("sends the waiting render once the one in flight is answered with %s", (_label, answer) => {
    bridge.setOnError(() => undefined);
    bridge.render();
    bridge.render();
    worker.reply(answer(inFlight(worker)));
    expect(renders(worker)).toHaveLength(2);
  });

  it("reports a renderError to onError and hands onFrame nothing", () => {
    const onError = vi.fn<(message: string) => void>();
    const onFrame = vi.fn<(frame: FrameResult) => void>();
    bridge.setOnError(onError);
    bridge.setOnFrame(onFrame);
    bridge.render();
    worker.reply({ type: "renderError", seq: inFlight(worker), message: "Shader compile failed" });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith("render failed: Shader compile failed");
    expect(onFrame).not.toHaveBeenCalled();
  });

  it("asks the waiting render for every histogram the renders it replaced asked for", () => {
    bridge.render();
    bridge.render(true, true);
    bridge.render(false);
    worker.reply(frameFor(inFlight(worker)));
    expect(renders(worker)[1]).toMatchObject({ wantHistogram: true, wantExtended: true });

    bridge.render();
    bridge.render(true);
    bridge.render();
    worker.reply(frameFor(inFlight(worker)));
    expect(renders(worker)[2]).toMatchObject({ wantHistogram: true, wantExtended: false });

    worker.reply(frameFor(inFlight(worker)));
    bridge.render();
    expect(renders(worker)[3]).toMatchObject({ wantHistogram: false, wantExtended: false });
  });

  it("frees nothing for an answer that carries a seq not in flight", () => {
    bridge.setOnError(() => undefined);
    bridge.render();
    bridge.render();
    const seq = inFlight(worker);
    worker.reply(frameFor(seq + 100));
    worker.reply({ type: "frameSkipped", seq: seq - 1 });
    worker.reply({ type: "renderError", seq: seq + 1, message: "stale" });
    expect(renders(worker)).toHaveLength(1);

    worker.reply(frameFor(seq));
    expect(renders(worker)).toHaveLength(2);
  });

  it("posts state messages at once, ahead of the render that waits", () => {
    bridge.render();
    bridge.render();
    bridge.setParams(normalizeParams({ exposure: 1 }));
    bridge.setViewport({ x: 0, y: 0, w: 0.5, h: 0.5 }, 100, 100);
    bridge.setMaskViz(0, [1, 0, 0], 0.5);
    bridge.setShowClipping(1);
    const order = () => worker.posted.map((m) => m.cmd).filter((cmd) => cmd !== "setPipeline");
    expect(order()).toEqual(["render", "setParams", "setViewport", "setMaskViz", "setShowClipping"]);

    worker.reply(frameFor(inFlight(worker)));
    expect(order()).toEqual([
      "render",
      "setParams",
      "setViewport",
      "setMaskViz",
      "setShowClipping",
      "render",
    ]);
  });

  // A histogram measures the worker's last render. Posted while a render waits here, it
  // would measure the one in flight, and the newest, the last of a drag, would go unmeasured.
  describe("a histogram asked for", () => {
    it("rides on the render that waits, extended as asked", () => {
      bridge.render();
      bridge.render();
      bridge.computeHistogram(true);
      expect(histograms(worker)).toEqual([]);

      worker.reply(frameFor(inFlight(worker)));
      expect(renders(worker)[1]).toMatchObject({ wantHistogram: true, wantExtended: true });
      expect(histograms(worker)).toEqual([]);
    });

    it("stays on the waiting render when a newer request replaces it", () => {
      bridge.render();
      bridge.render();
      bridge.computeHistogram(false);
      bridge.render(false);
      worker.reply(frameFor(inFlight(worker)));
      expect(renders(worker)[1]).toMatchObject({ wantHistogram: true, wantExtended: false });
    });

    it.each([
      ["no render is in flight", false],
      ["the render in flight is the newest", true],
    ])("goes at once when %s", (_label, busy) => {
      if (busy) bridge.render();
      bridge.computeHistogram(true);
      expect(worker.posted.at(-1)).toEqual({ cmd: "computeHistogram", wantExtended: true });
      expect(renders(worker)).toHaveLength(busy ? 1 : 0);
    });
  });

  // A reply that never comes (a worker stuck, a message lost) must not stop the view
  // for good.
  describe("when the worker does not answer", () => {
    beforeEach(() => ready(worker));

    it("moves on after 2 s: logs it and sends the waiting render", () => {
      bridge.render();
      bridge.render();
      vi.advanceTimersByTime(1_999);
      expect(renders(worker)).toHaveLength(1);
      expect(warn).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(renders(worker)).toHaveLength(2);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("not answered");
    });

    it("sends the next render at once after 2 s with none waiting", () => {
      bridge.render();
      vi.advanceTimersByTime(2_000);
      bridge.render();
      expect(renders(worker)).toHaveLength(2);
    });

    it("times each render from its own post", () => {
      bridge.render();
      vi.advanceTimersByTime(1_500);
      worker.reply(frameFor(inFlight(worker)));
      bridge.render();
      vi.advanceTimersByTime(1_500);
      expect(warn).not.toHaveBeenCalled();
      vi.advanceTimersByTime(500);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it("still hands over a frame that comes late, without freeing the newer render", () => {
      const onFrame = vi.fn<(frame: FrameResult) => void>();
      bridge.setOnFrame(onFrame);
      bridge.render();
      const late = inFlight(worker);
      vi.advanceTimersByTime(2_000);
      bridge.render();
      expect(renders(worker)).toHaveLength(2);

      worker.reply(frameFor(late));
      expect(onFrame).toHaveBeenCalledTimes(1);
      bridge.render();
      expect(renders(worker)).toHaveLength(2);
    });
  });

  // A worker drawing a heavy photo on a weak GPU says nothing until each render is done,
  // just like one that has stopped. Every render posted while it draws queues in it, and
  // the view plays that queue back after the user lets go.
  describe("when the worker is slow, or goes quiet", () => {
    beforeEach(() => ready(worker));

    /** The worker draws renders one after another, in the order they come, taking `ms`
     *  over each, and answers each once it is drawn. Each frame shows `edit()` as it was
     *  when its render was posted: the state messages before it are what it draws. */
    function drawsEachIn(ms: number, edit: () => number) {
      const queued: number[] = [];
      const shows = new Map<number, number>();
      const drawn: { at: number; edit: number | undefined }[] = [];
      let drawing = false;
      const drawNext = () => {
        const seq = queued.shift();
        drawing = seq !== undefined;
        if (seq === undefined) return;
        setTimeout(() => {
          drawn.push({ at: performance.now(), edit: shows.get(seq) });
          worker.reply(frameFor(seq));
          drawNext();
        }, ms);
      };
      const post = worker.postMessage.bind(worker);
      worker.postMessage = (msg: WorkerRequest, transfer: Transferable[] = []) => {
        post(msg, transfer);
        if (msg.cmd !== "render") return;
        shows.set(msg.seq, edit());
        queued.push(msg.seq);
        if (!drawing) drawNext();
      };
      return { queued: () => queued.length, drawn };
    }

    it("queues at most one render behind the one drawn through a drag of 3 s renders", () => {
      let edit = 0;
      const slow = drawsEachIn(3_000, () => edit);
      let mostQueued = 0;
      for (let t = 0; t < 30_000; t += 16) {
        edit++;
        bridge.render();
        vi.advanceTimersByTime(16);
        mostQueued = Math.max(mostQueued, slow.queued());
      }
      const letGo = performance.now();
      vi.advanceTimersByTime(60_000);

      expect(mostQueued).toBeLessThanOrEqual(1);
      const afterwards = slow.drawn.filter((frame) => frame.at > letGo);
      expect(afterwards.length).toBeLessThanOrEqual(2);
      expect(afterwards.at(-1)?.edit).toBe(edit);
      expect(afterwards.at(-1)?.at).toBeLessThanOrEqual(letGo + 6_000);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it("allows a worker that came back late three times as long as it took", () => {
      bridge.render();
      vi.advanceTimersByTime(3_000);
      expect(warn).toHaveBeenCalledTimes(1);
      worker.reply(frameFor(inFlight(worker)));

      bridge.render();
      bridge.render();
      vi.advanceTimersByTime(8_999);
      expect(renders(worker)).toHaveLength(2);
      expect(warn).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(renders(worker)).toHaveLength(3);
      expect(warn).toHaveBeenCalledTimes(2);
    });

    it("times the render sent after one given up on from its post, once the late answer came", () => {
      bridge.render();
      bridge.render();
      vi.advanceTimersByTime(2_000);
      const [givenUp] = renders(worker).map((r) => r.seq);
      vi.advanceTimersByTime(1_000);
      worker.reply(frameFor(givenUp));
      bridge.render();

      vi.advanceTimersByTime(7_999);
      expect(renders(worker)).toHaveLength(2);
      vi.advanceTimersByTime(1);
      expect(renders(worker)).toHaveLength(3);
      expect(warn).toHaveBeenCalledTimes(2);
    });

    it("gives up after 2 s again once its last eight answers came quickly", () => {
      bridge.render();
      vi.advanceTimersByTime(3_000);
      worker.reply(frameFor(inFlight(worker)));
      for (let i = 0; i < 8; i++) {
        bridge.render();
        vi.advanceTimersByTime(100);
        worker.reply(frameFor(inFlight(worker)));
      }

      bridge.render();
      bridge.render();
      vi.advanceTimersByTime(2_000);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(renders(worker)).toHaveLength(11);
    });

    it("sends nothing more to a worker quiet for under 30 s, and the newest request once it answers", () => {
      bridge.render();
      bridge.render();
      vi.advanceTimersByTime(2_000);
      expect(renders(worker)).toHaveLength(2);
      const [givenUp, sentAfter] = renders(worker).map((r) => r.seq);

      for (let i = 0; i < 45; i++) {
        bridge.render(i === 20);
        vi.advanceTimersByTime(600);
      }
      expect(renders(worker)).toHaveLength(2);
      expect(warn).toHaveBeenCalledTimes(1);

      worker.reply(frameFor(givenUp));
      expect(renders(worker)).toHaveLength(2);
      worker.reply(frameFor(sentAfter));
      expect(renders(worker)).toHaveLength(3);
      expect(renders(worker)[2]).toMatchObject({ wantHistogram: true });
    });

    // The answers to the render given up on and to the one after it could both be lost.
    // A worker that says nothing at all for 30 s gets the newest request anyway.
    it("sends the newest request after 30 s with no word from the worker", () => {
      bridge.render();
      bridge.render();
      vi.advanceTimersByTime(2_000);
      bridge.render(true);
      vi.advanceTimersByTime(27_999);
      expect(renders(worker)).toHaveLength(2);

      vi.advanceTimersByTime(1);
      expect(renders(worker)).toHaveLength(3);
      expect(renders(worker)[2]).toMatchObject({ wantHistogram: true });
      expect(warn).toHaveBeenCalledTimes(2);

      bridge.render();
      vi.advanceTimersByTime(29_999);
      expect(renders(worker)).toHaveLength(3);
      vi.advanceTimersByTime(1);
      expect(renders(worker)).toHaveLength(4);
    });

    it("counts the 30 s from the worker's last word of any kind", () => {
      bridge.render();
      bridge.render();
      vi.advanceTimersByTime(2_000);
      bridge.render();
      vi.advanceTimersByTime(18_000);
      worker.reply({ type: "healSource", data: new Uint8ClampedArray(4), width: 1, height: 1 });

      vi.advanceTimersByTime(29_999);
      expect(renders(worker)).toHaveLength(2);
      vi.advanceTimersByTime(1);
      expect(renders(worker)).toHaveLength(3);
    });

    it("gives a render the slow worker's own time once the one given up on is answered", () => {
      bridge.render();
      bridge.render();
      vi.advanceTimersByTime(2_000);
      const [givenUp] = renders(worker).map((r) => r.seq);
      vi.advanceTimersByTime(27_000);
      worker.reply(frameFor(givenUp));
      bridge.render();

      vi.advanceTimersByTime(59_999);
      expect(renders(worker)).toHaveLength(2);
      vi.advanceTimersByTime(1);
      expect(renders(worker)).toHaveLength(3);
    });

    it("lets the answer to a render it gave up on after 30 s free nothing", () => {
      bridge.render();
      bridge.render();
      vi.advanceTimersByTime(2_000);
      const [givenUp, sentAfter] = renders(worker).map((r) => r.seq);
      bridge.render();
      vi.advanceTimersByTime(28_000);
      expect(renders(worker)).toHaveLength(3);

      worker.reply(frameFor(givenUp));
      bridge.render();
      expect(renders(worker)).toHaveLength(3);
      worker.reply(frameFor(sentAfter));
      expect(renders(worker)).toHaveLength(3);
      worker.reply(frameFor(inFlight(worker)));
      expect(renders(worker)).toHaveLength(4);
    });

    // The worker answers renders in order: once it answers the render sent after the one
    // given up on, that one's answer was lost and will never come.
    it("moves on when the render sent after one whose answer was lost is answered", () => {
      bridge.render();
      bridge.render();
      vi.advanceTimersByTime(2_000);
      worker.reply(frameFor(inFlight(worker)));
      bridge.render();
      expect(renders(worker)).toHaveLength(3);

      bridge.render();
      vi.advanceTimersByTime(2_000);
      expect(renders(worker)).toHaveLength(4);
      expect(warn).toHaveBeenCalledTimes(2);
    });
  });

  // Until `ready` the worker is creating its renderer and building the first program,
  // which can outlast the watchdog, and it draws nothing before that is done. A render
  // sent meanwhile holds the slot untimed and is timed from `ready`.
  describe("while the worker starts", () => {
    it("neither warns nor sends another render during a 3 s init", () => {
      bridge.render();
      bridge.render();
      vi.advanceTimersByTime(3_000);
      expect(warn).not.toHaveBeenCalled();
      expect(renders(worker)).toHaveLength(1);
    });

    it("times a render sent before ready from ready, and moves on 2 s after it", () => {
      bridge.render();
      bridge.render();
      vi.advanceTimersByTime(3_000);
      ready(worker);
      vi.advanceTimersByTime(1_999);
      expect(warn).not.toHaveBeenCalled();
      expect(renders(worker)).toHaveLength(1);

      vi.advanceTimersByTime(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(renders(worker)).toHaveLength(2);
    });

    it("starts no timer when ready lands with no render in flight", () => {
      ready(worker);
      expect(vi.getTimerCount()).toBe(0);
      bridge.render();
      expect(vi.getTimerCount()).toBe(1);
    });

    it("waits for ready again while a failed init is retried", () => {
      bridge.setOnError(() => undefined);
      bridge.init(64, 64);
      worker.reply(initError);
      vi.advanceTimersByTime(1_000);
      expect(inits(worker)).toHaveLength(2);
      bridge.render();
      bridge.render();
      vi.advanceTimersByTime(3_000);
      expect(warn).not.toHaveBeenCalled();
      expect(renders(worker)).toHaveLength(1);

      ready(worker);
      vi.advanceTimersByTime(2_000);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(renders(worker)).toHaveLength(2);
    });
  });

  describe("on init, initError and dispose", () => {
    it("starts empty when init is posted again, and an answer from before frees nothing", () => {
      bridge.render();
      bridge.render(true, true);
      const before = inFlight(worker);
      bridge.init(64, 64);
      bridge.render();
      expect(renders(worker)).toHaveLength(2);
      expect(renders(worker)[1]).toMatchObject({ wantHistogram: false });

      worker.reply(frameFor(before));
      bridge.render();
      expect(renders(worker)).toHaveLength(2);
    });

    it("starts empty after an initError, and again when the init is retried", () => {
      bridge.setOnError(() => undefined);
      bridge.init(64, 64);
      bridge.render();
      bridge.render();
      worker.reply(initError);
      bridge.render();
      expect(renders(worker)).toHaveLength(2);

      bridge.render();
      vi.advanceTimersByTime(1_000);
      expect(inits(worker)).toHaveLength(2);
      bridge.render();
      expect(renders(worker)).toHaveLength(3);
    });

    it("sends nothing more, and leaves no timer running, once disposed", () => {
      ready(worker);
      bridge.render();
      bridge.render();
      expect(vi.getTimerCount()).toBe(1);
      bridge.dispose();
      expect(vi.getTimerCount()).toBe(0);

      worker.reply(frameFor(inFlight(worker)));
      bridge.render();
      vi.advanceTimersByTime(10_000);
      expect(renders(worker)).toHaveLength(1);
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
