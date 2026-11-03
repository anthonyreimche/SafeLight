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
} from "./render-bridge";
import type { HistogramData } from "./histogram";
import type { WorkerRequest, WorkerResponse } from "./render-protocol";
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
import { makeScopedAPI } from "@/extensions/host";
import { setExtSetting } from "@/extensions/ext-settings";
import { useCatalogStore } from "@/state/catalog-store";
import { photo as photoFixture } from "@/catalog/stored-edit.fixtures";
import type { ProcessingStageContribution, StageSpace, StageTextureData } from "@/extensions/types";
import type { MonitorTransform } from "./display-profile";
import { useDisplayProfile, type DisplayProfileState } from "./display-profile-store";
import { DEFAULT_CAPTURE_SPACE, type CapturePoint, type FloatFrame } from "./float-frame";
import type { SourceSample } from "./source-sample";
import { setSourcePixels, sourcePixels } from "./source-pixels";
import { stageSignature } from "./webgl/stage-injection";
import { stageFailuresOf, useStageFailures } from "./render-bridge/stage-failures";
import { setExtensionName } from "@/extensions/param-registry";

const gpu = vi.hoisted(() => ({
  rendererFailed: vi.fn<(detail: string) => Promise<null>>(async () => null),
}));

vi.mock("@/native/privileged", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/native/privileged")>()),
  privilegedGpu: () => ({
    backend: async () => null,
    setSoftware: async () => null,
    rendererFailed: gpu.rendererFailed,
  }),
}));

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

// The bridge answers a capture it gives up on with a blank bitmap, as the worker
// does, and jsdom has no OffscreenCanvas to draw one.
class FakeOffscreenCanvas {
  readonly width: number;
  readonly height: number;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  transferToImageBitmap(): ImageBitmap {
    return { width: this.width, height: this.height, close: () => undefined };
  }
}
Object.assign(globalThis, { OffscreenCanvas: FakeOffscreenCanvas });

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

  it("tells its availability listener why the last init failed", () => {
    const bridge = new RenderBridge();
    bridge.setOnError(() => undefined);
    const seen: Array<[string, string | undefined]> = [];
    bridge.setOnAvailability((availability, detail) => seen.push([availability, detail]));
    bridge.init(64, 64);
    FakeWorker.instances[0].reply(initError);
    expect(seen.at(-1)).toEqual(["retrying", "WebGL2 not supported"]);
    FakeWorker.instances[0].reply({ type: "ready", pipelineFloat: true });
    expect(seen.at(-1)).toEqual(["ready", undefined]);
    bridge.dispose();
  });

  it("tells a listener that subscribes after a failed init why it failed", () => {
    const bridge = new RenderBridge();
    bridge.setOnError(() => undefined);
    bridge.init(64, 64);
    FakeWorker.instances[0].reply(initError);
    const onAvailability = vi.fn<(availability: string, detail?: string) => void>();
    bridge.setOnAvailability(onAvailability);
    expect(onAvailability).toHaveBeenCalledWith("retrying", "WebGL2 not supported");
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

  // Main moves the next launch to software and offers the restart.
  it("tells main the renderer can't run on this launch's graphics once it gives up", () => {
    gpu.rendererFailed.mockClear();
    const bridge = new RenderBridge();
    bridge.setOnError(() => undefined);
    bridge.init(64, 64);
    const worker = FakeWorker.instances[0];
    for (let i = 0; i < 20; i++) {
      worker.reply(initError);
      vi.advanceTimersByTime(60_000);
    }
    expect(gpu.rendererFailed.mock.calls).toEqual([["WebGL2 not supported"]]);
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

  // A restored graphics context that can't make a renderer is answered like a first init,
  // whatever the boot's retries spent.
  it("gives a restore that fails the whole retry budget again", () => {
    const bridge = new RenderBridge();
    bridge.setOnError(() => undefined);
    bridge.init(64, 64);
    const worker = FakeWorker.instances[0];
    for (let i = 0; i < 5; i++) {
      worker.reply(initError);
      vi.advanceTimersByTime(60_000);
    }
    worker.reply({ type: "ready", pipelineFloat: true });
    worker.reply({ type: "contextLost" });
    const before = inits(worker).length;
    for (let i = 0; i < 9; i++) {
      worker.reply(initError);
      vi.advanceTimersByTime(60_000);
    }
    expect(bridge.availability).toBe("retrying");
    expect(inits(worker).length - before).toBe(9);
    worker.reply(initError);
    expect(bridge.availability).toBe("failed");
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

  it("captures floats with the pick of the params they carry", () => {
    const bridge = new RenderBridge();
    const worker = FakeWorker.instances[0];
    void bridge.captureFloat(normalizeParams({ displayTransform: AGX.id }));
    void bridge.captureFloat(normalizeParams({}));
    const sent = worker.posted.flatMap((m) => (m.cmd === "captureFloat" ? [m.pipeline.id] : []));
    expect(sent).toEqual([AGX.id, DEFAULT_PIPELINE]);
    bridge.dispose();
  });

  it("renders float thumbnails with the pick of the params they carry", () => {
    const bridge = new RenderBridge();
    const worker = FakeWorker.instances[0];
    const request = { asShotTemperature: 5000, maxEdge: 640, float: {} };
    void bridge.renderThumbnailFloat({
      ...request,
      requestId: "f1",
      key: "k",
      params: normalizeParams({ displayTransform: AGX.id }),
    });
    void bridge.renderThumbnailFloat({
      ...request,
      requestId: "f2",
      image: { kind: "float16", data: new Uint16Array(4), width: 1, height: 1 },
      params: normalizeParams({}),
    });
    const sent = worker.posted.flatMap((m) =>
      m.cmd === "renderThumbnailFromSource" || m.cmd === "renderThumbnail" ? [[m.cmd, m.pipeline.id]] : [],
    );
    expect(sent).toEqual([
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
    const retouch = [spot("s1"), spot("s2")];
    bridge.setParams(base);
    bridge.setParams({ ...base, retouch });

    const [patch] = patches(worker);
    expect(Object.keys(patch.set)).toEqual(["retouch"]);
    expect(patch.set.retouch).toBe(retouch);
    bridge.dispose();
  });

  // Posted whole, a mask slider tick cloned every brush dab of every mask, and the worker
  // held new dab arrays the renderer had to sign again.
  describe("masks", () => {
    const brushed = (id: string): Mask => ({
      ...mask(id),
      components: [
        {
          id: `${id}-c`,
          kind: "brush",
          mode: "add",
          invert: false,
          brush: { dabs: [{ x: 0.5, y: 0.5, radius: 0.1, erase: false, feather: 0 }], feather: 0 },
        },
      ],
    });
    const withMasks = (masks: Mask[]): DevelopParams => ({ ...painted(), masks });

    it("posts a mask slider tick as that mask's changed field alone", () => {
      const bridge = new RenderBridge();
      const worker = FakeWorker.instances[0];
      const [m1, m2] = [brushed("m1"), brushed("m2")];
      const base = withMasks([m1, m2]);
      bridge.setParams(base);
      const adj = { ...m1.adj, exposure: 40 };
      bridge.setParams({ ...base, masks: [{ ...m1, adj }, m2] });

      expect(patches(worker)).toStrictEqual([
        {
          cmd: "patchParams",
          set: {},
          remove: [],
          masks: [
            { id: "m1", set: { adj }, remove: [] },
            { id: "m2", set: {}, remove: [] },
          ],
        },
      ]);
      bridge.dispose();
    });

    it("posts a new mask whole and a dropped mask field as a removal, in the masks' order", () => {
      const bridge = new RenderBridge();
      const worker = FakeWorker.instances[0];
      const m1 = { ...brushed("m1"), bag: { "a.gain": 1 } };
      const base = withMasks([m1]);
      bridge.setParams(base);
      const added = brushed("m2");
      const withoutBag: Mask = { ...m1 };
      delete withoutBag.bag;
      bridge.setParams({ ...base, masks: [added, withoutBag] });

      const [patch] = patches(worker);
      expect(patch.set).toStrictEqual({});
      expect(patch.masks).toStrictEqual([{ mask: added }, { id: "m1", set: {}, remove: ["bag"] }]);
      expect(patch.masks?.[0]).toHaveProperty("mask", added);
      bridge.dispose();
    });

    it("posts the masks whole when their ids don't name one mask each", () => {
      const bridge = new RenderBridge();
      const worker = FakeWorker.instances[0];
      const base = withMasks([brushed("m1")]);
      bridge.setParams(base);
      const twins = [brushed("m1"), brushed("m1")];
      bridge.setParams({ ...base, masks: twins });

      const [patch] = patches(worker);
      expect(patch.set.masks).toBe(twins);
      expect(patch).not.toHaveProperty("masks");
      bridge.dispose();
    });
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
    expect(paramsPosts(worker)[2]).toStrictEqual({ cmd: "setParams", params: after, derived: {} });
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
    expect(paramsPosts(worker)[2]).toStrictEqual({ cmd: "setParams", params: after, derived: {} });
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
    expect(paramsPosts(worker)[0]).toStrictEqual({ cmd: "setParams", params: next, derived: {} });
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

    const shownTransfer = transferOf("setImage");
    expect(shownTransfer).toHaveLength(1);
    expect(shownTransfer[0]).toBe(shown.data.buffer);
    const uploadedTransfer = transferOf("uploadSource");
    expect(uploadedTransfer).toHaveLength(1);
    expect(uploadedTransfer[0]).toBe(uploaded.data.buffer);
    const thumbTransfer = transferOf("renderThumbnail");
    expect(thumbTransfer).toHaveLength(1);
    expect(thumbTransfer[0]).toBe(thumb.data.buffer);
    bridge.dispose();
  });

  it("transfers a cached preview's sample beside its pixels", () => {
    const bridge = new RenderBridge();
    const worker = FakeWorker.instances[0];
    const transferOf = (cmd: WorkerRequest["cmd"]) =>
      worker.transfers[worker.posted.findIndex((m) => m.cmd === cmd)];
    const sampleOf = () => ({ data: new Uint16Array(4), width: 1, height: 1, x: 0, y: 0, sourceWidth: 6, sourceHeight: 4 });

    const shown = { ...cachedPreview(), fullWidth: 6, fullHeight: 4, sample: sampleOf() };
    const uploaded = { ...cachedPreview(), fullWidth: 6, fullHeight: 4, sample: sampleOf() };
    bridge.setImage(shown);
    bridge.uploadSource("main", "k", uploaded);

    const shownTransfer = transferOf("setImage");
    expect(shownTransfer).toHaveLength(2);
    expect(shownTransfer[0]).toBe(shown.data.buffer);
    expect(shownTransfer[1]).toBe(shown.sample.data.buffer);
    const uploadedTransfer = transferOf("uploadSource");
    expect(uploadedTransfer).toHaveLength(2);
    expect(uploadedTransfer[0]).toBe(uploaded.data.buffer);
    expect(uploadedTransfer[1]).toBe(uploaded.sample.data.buffer);
    bridge.dispose();
  });

  // The sample is 8 MB; it moves to the worker rather than being copied.
  it("hands a completed entry's size and sample to the worker, moving the sample", () => {
    const bridge = new RenderBridge();
    const worker = FakeWorker.instances[0];
    const sample = { data: new Uint16Array(8), width: 2, height: 1, x: 0, y: 0, sourceWidth: 6, sourceHeight: 4 };

    bridge.setSourceSample("p:0", { fullWidth: 6, fullHeight: 4, sample });

    const at = worker.posted.findIndex((m) => m.cmd === "setSourceSample");
    expect(worker.posted[at]).toEqual({ cmd: "setSourceSample", key: "p:0", fullWidth: 6, fullHeight: 4, sample });
    expect(worker.transfers[at]).toHaveLength(1);
    expect(worker.transfers[at][0]).toBe(sample.data.buffer);
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
  const lastPatch = (worker: FakeWorker) =>
    worker.posted.filter((m) => m.cmd === "patchStageTextures").at(-1);

  beforeEach(() => {
    vi.useFakeTimers();
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
    useRegistry.setState({ processingStages: {} });
  });

  afterEach(() => {
    for (const key of Object.keys(getStageTextures())) setStageTexture(key, null);
    disposeRenderBridge();
    useRegistry.setState({ processingStages: {} });
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("drops them from the bag and tells the worker which went", () => {
    getRenderBridge();
    const worker = FakeWorker.instances[0];
    registerProcessingStage("acme.film", stage("acme.film.grade"));
    registerProcessingStage("acme.tone", stage("acme.tone.curve"));
    setStageTexture("acme.film.grade.lut", texture(1));
    setStageTexture("acme.film.grade.spectra", texture(1));
    setStageTexture("acme.tone.curve.lut", texture(1));
    vi.advanceTimersToNextFrame();

    unregisterExtension("acme.film");
    vi.advanceTimersToNextFrame();

    expect(Object.keys(getStageTextures())).toEqual(["acme.tone.curve.lut"]);
    expect(lastPatch(worker)).toEqual({
      cmd: "patchStageTextures",
      set: {},
      remove: ["acme.film.grade.lut", "acme.film.grade.spectra"],
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

// Posting clones every texture it carries, and an extension may upload many in a burst
// (a film stock's LUTs and spectral tables), so only what changed goes, once a frame.
// A texture the renderer can't upload as described would draw black without a word, so
// it is refused here, by name.
describe("stage textures sent to the worker", () => {
  const stage = (id: string): ProcessingStageContribution => ({
    id,
    name: id,
    phase: "effects",
    glsl: "c = c;",
    uniforms: [],
  });
  const texture = (version: number, over: Partial<StageTextureData> = {}): StageTextureData => ({
    data: new Uint8Array([0, 0, 0, 255]),
    width: 1,
    height: 1,
    format: "rgba8",
    version,
    ...over,
  });
  const MB = 1024 * 1024;
  // One buffer behind every big texture: each view counts at its full size.
  const big = new ArrayBuffer(64 * MB);
  const bigTexture = (): StageTextureData =>
    texture(1, { data: new Uint8Array(big), width: 8192, height: 8192, format: "r8" });
  const posts = (worker: FakeWorker) =>
    worker.posted.filter((m) => m.cmd === "setStageTextures" || m.cmd === "patchStageTextures");

  beforeEach(() => {
    vi.useFakeTimers();
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
    useRegistry.setState({ processingStages: {} });
    registerProcessingStage("acme.film", stage("acme.film"));
    registerProcessingStage("acme.tone", stage("acme.tone"));
  });

  afterEach(() => {
    for (const key of Object.keys(getStageTextures())) setStageTexture(key, null);
    disposeRenderBridge();
    useRegistry.setState({ processingStages: {} });
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("posts the textures set and cleared in a frame once, each at its last value", () => {
    getRenderBridge();
    const worker = FakeWorker.instances[0];
    setStageTexture("acme.film.lut", texture(1));
    setStageTexture("acme.film.spectra", texture(1));
    setStageTexture("acme.film.lut", texture(2));
    expect(posts(worker)).toEqual([]);

    vi.advanceTimersToNextFrame();
    expect(posts(worker)).toEqual([
      {
        cmd: "patchStageTextures",
        set: { "acme.film.lut": texture(2), "acme.film.spectra": texture(1) },
        remove: [],
      },
    ]);

    setStageTexture("acme.film.lut", texture(3));
    setStageTexture("acme.film.spectra", null);
    setStageTexture("acme.film.grain", texture(1));
    setStageTexture("acme.film.grain", null);
    vi.advanceTimersToNextFrame();
    expect(posts(worker).slice(1)).toEqual([
      {
        cmd: "patchStageTextures",
        set: { "acme.film.lut": texture(3) },
        remove: ["acme.film.spectra", "acme.film.grain"],
      },
    ]);

    vi.advanceTimersToNextFrame();
    expect(posts(worker)).toHaveLength(2);
  });

  it("posts the textures ahead of the redraw they call for", () => {
    getRenderBridge();
    const worker = FakeWorker.instances[0];
    registerProcessingStage("acme.grain", stage("acme.grain"));
    setStageTexture("acme.film.lut", texture(1));
    vi.advanceTimersToNextFrame();
    const cmds = worker.posted.map((m) => m.cmd);
    const patched = cmds.lastIndexOf("patchStageTextures");
    expect(patched).toBeGreaterThan(-1);
    expect(patched).toBeLessThan(cmds.lastIndexOf("render"));
  });

  it("hands a new bridge the whole bag, and nothing it held back for the last one", () => {
    getRenderBridge();
    setStageTexture("acme.film.lut", texture(1));
    disposeRenderBridge();
    setStageTexture("acme.tone.lut", texture(1));

    getRenderBridge();
    const worker = FakeWorker.instances[1];
    vi.advanceTimersToNextFrame();
    expect(posts(worker)).toEqual([
      { cmd: "setStageTextures", bag: { "acme.film.lut": texture(1), "acme.tone.lut": texture(1) } },
    ]);
    expect(posts(FakeWorker.instances[0])).toEqual([]);
  });

  it.each<[string, StageTextureData, RegExp]>([
    ["an unknown format", texture(1, { format: "rgb8" as StageTextureData["format"] }), /unknown format "rgb8"/],
    ["a zero width", texture(1, { width: 0 }), /width and height/],
    ["a fractional height", texture(1, { height: 1.5 }), /width and height/],
    ["too few values", texture(1, { width: 2 }), /holds 4 values.*takes 8/],
    ["the wrong array for its format", texture(1, { format: "rgba16f" }), /Float32Array/],
    ["more than 64 MB", texture(1, { data: new Uint8Array(8193 * 8192), width: 8193, height: 8192, format: "r8" }), /64 MB/],
  ])("refuses a texture with %s, by extension and key", (_what, tex, reason) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    getRenderBridge();
    const worker = FakeWorker.instances[0];
    setStageTexture("acme.film.lut", texture(1));
    setStageTexture("acme.film.lut", tex);
    vi.advanceTimersToNextFrame();

    expect(getStageTextures()["acme.film.lut"]).toEqual(texture(1));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/acme\.film.*"acme\.film\.lut"/);
    expect(warn.mock.calls[0][0]).toMatch(reason);
    expect(posts(worker)).toEqual([
      { cmd: "patchStageTextures", set: { "acme.film.lut": texture(1) }, remove: [] },
    ]);
  });

  it("refuses a texture that takes an extension past 256 MB, and keeps the rest", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const key of ["a", "b", "c", "d"]) setStageTexture(`acme.film.${key}`, bigTexture());
    setStageTexture("acme.film.d", bigTexture());
    expect(warn).not.toHaveBeenCalled();

    setStageTexture("acme.film.e", bigTexture());
    expect(getStageTextures()["acme.film.e"]).toBeUndefined();
    expect(warn.mock.calls[0][0]).toMatch(/acme\.film.*"acme\.film\.e".*256 MB/);

    setStageTexture("acme.tone.lut", bigTexture());
    expect(getStageTextures()["acme.tone.lut"]).toBeDefined();
  });

  // Canvas ImageData hands its pixels over as a Uint8ClampedArray, which uploads as bytes.
  it("takes an 8-bit texture in a Uint8ClampedArray", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const clamped = texture(1, { data: new Uint8ClampedArray(4) as unknown as Uint8Array });
    setStageTexture("acme.film.lut", clamped);
    expect(warn).not.toHaveBeenCalled();
    expect(getStageTextures()["acme.film.lut"]).toBe(clamped);
  });

  it("lets a clear through for a key it never held", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setStageTexture("acme.gone.lut", null);
    expect(warn).not.toHaveBeenCalled();
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
  const pixels = (width: number, height: number) => ({ data: new Uint8Array(width * height * 4).fill(7), width, height });
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
  const frameOf = (point: CapturePoint): FloatFrame => ({
    data: new Float32Array([1.5, 0.5, -0.1, 1]),
    width: 1,
    height: 1,
    space: DEFAULT_CAPTURE_SPACE,
    point,
  });
  const WIDE: StageSpace = { encoding: "perceptual", primaries: "rec2020" };

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
      // A frame from an older worker build names no decoded size: it is the source's,
      // and the source is not known to be a live decode.
      expect(frame).toMatchObject({ sourceFullWidth: 4096, sourceFullHeight: 2731, sourceNative: false });
      expect(frame.histogram).toBe(histogram);
    });

    it("hands over the decoded size and kind a frame carries as they are", () => {
      const onFrame = vi.fn<(frame: FrameResult) => void>();
      bridge.setOnFrame(onFrame);
      worker.reply({
        type: "frame",
        seq: 1,
        bitmap: bitmapOf(640),
        width: 640,
        height: 480,
        sourceWidth: 4096,
        sourceHeight: 2731,
        sourceGen: 3,
        sourceFullWidth: 6000,
        sourceFullHeight: 4000,
        sourceNative: true,
      });

      expect(onFrame).toHaveBeenCalledTimes(1);
      expect(onFrame.mock.calls[0][0]).toMatchObject({
        sourceWidth: 4096,
        sourceHeight: 2731,
        sourceFullWidth: 6000,
        sourceFullHeight: 4000,
        sourceNative: true,
      });
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

    it("hands over the window a frame was drawn for, and null for the whole image", () => {
      const onFrame = vi.fn<(frame: FrameResult) => void>();
      bridge.setOnFrame(onFrame);
      const frame = { type: "frame", width: 320, height: 240, sourceWidth: 320, sourceHeight: 240, sourceGen: 1 } as const;
      worker.reply({ ...frame, seq: 1, bitmap: bitmapOf(320), roi: { x: 0, y: 0, w: 0.5, h: 0.5 } });
      worker.reply({ ...frame, seq: 2, bitmap: bitmapOf(320) });

      expect(onFrame.mock.calls.map(([f]) => f.roi)).toEqual([{ x: 0, y: 0, w: 0.5, h: 0.5 }, null]);
    });

    it("hands over the size of a frame of the whole image, and 0 when a frame doesn't say", () => {
      const onFrame = vi.fn<(frame: FrameResult) => void>();
      bridge.setOnFrame(onFrame);
      const frame = { type: "frame", width: 320, height: 240, sourceWidth: 320, sourceHeight: 240, sourceGen: 1 } as const;
      const roi = { x: 0, y: 0, w: 0.5, h: 0.5 };
      worker.reply({ ...frame, seq: 1, bitmap: bitmapOf(320), roi, wholeWidth: 640, wholeHeight: 427 });
      worker.reply({ ...frame, seq: 2, bitmap: bitmapOf(320) });

      expect(onFrame.mock.calls.map(([f]) => [f.wholeWidth, f.wholeHeight])).toEqual([
        [640, 427],
        [0, 0],
      ]);
    });

    it("hands over the region a frame was drawn for, and null when a frame doesn't say", () => {
      const onFrame = vi.fn<(frame: FrameResult) => void>();
      bridge.setOnFrame(onFrame);
      const frame = { type: "frame", width: 320, height: 240, sourceWidth: 320, sourceHeight: 240, sourceGen: 1 } as const;
      const crop = { x: 0.1, y: 0, width: 0.8, height: 1 };
      worker.reply({ ...frame, seq: 1, bitmap: bitmapOf(320), crop });
      worker.reply({ ...frame, seq: 2, bitmap: bitmapOf(320) });

      expect(onFrame.mock.calls.map(([f]) => f.crop)).toEqual([crop, null]);
    });

    it("hands over the stages a frame was drawn without, and none when it names none", () => {
      const onFrame = vi.fn<(frame: FrameResult) => void>();
      bridge.setOnFrame(onFrame);
      const frame = { type: "frame", width: 320, height: 240, sourceWidth: 320, sourceHeight: 240, sourceGen: 1 } as const;
      worker.reply({ ...frame, seq: 1, bitmap: bitmapOf(320), overflowedStages: ["ext.equaliser.rings"] });
      worker.reply({ ...frame, seq: 2, bitmap: bitmapOf(320) });

      expect(onFrame.mock.calls.map(([f]) => f.overflowedStages)).toEqual([["ext.equaliser.rings"], []]);
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
        worker.reply({ type: "developedPixels", reqId: 999, pixels: pixels(1, 1) });
        worker.reply({ type: "sourcePixels", sourceGen: 0, data: new Uint8ClampedArray(4), width: 1, height: 1 });
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
    it("resolves renderThumbnailAsync with the blob", async () => {
      const blob = new Blob(["jpeg"]);
      const outcome = track(bridge.renderThumbnailAsync(thumbRequest("t1")));
      expect(sent(worker, "renderThumbnail").map((m) => m.requestId)).toEqual(["t1"]);
      expect(outcome.state).toBe("pending");

      worker.reply({ type: "thumbnail", requestId: "t1", blob });
      await flush();

      expect(outcome.state).toBe("resolved");
      expect(outcome.value).toBe(blob);
    });

    it("resolves renderThumbnailFromSource with the blob", async () => {
      const blob = new Blob(["jpeg"]);
      const outcome = track(bridge.renderThumbnailFromSource(sourceRequest("s1")));
      worker.reply({ type: "thumbnail", requestId: "s1", blob });
      await flush();

      expect(outcome.state).toBe("resolved");
      expect(outcome.value).toBe(blob);
    });

    it("forwards a lossless request to the worker on both thumbnail calls", () => {
      track(bridge.renderThumbnailFromSource({ ...sourceRequest("s1"), lossless: true }));
      track(bridge.renderThumbnailAsync({ ...thumbRequest("t1"), lossless: true }));

      expect(sent(worker, "renderThumbnailFromSource").map((m) => [m.requestId, m.lossless])).toEqual([
        ["s1", true],
      ]);
      expect(sent(worker, "renderThumbnail").map((m) => [m.requestId, m.lossless])).toEqual([
        ["t1", true],
      ]);
    });

    it("adds no lossless field to a thumbnail request that didn't ask for one", () => {
      track(bridge.renderThumbnailFromSource({ ...sourceRequest("s1"), quality: 0.9 }));
      track(bridge.renderThumbnailAsync({ ...thumbRequest("t1"), quality: 0.9 }));

      const [fromSource] = sent(worker, "renderThumbnailFromSource");
      const [fromBitmap] = sent(worker, "renderThumbnail");
      expect(fromSource).not.toHaveProperty("lossless");
      expect(fromBitmap).not.toHaveProperty("lossless");
      expect(fromSource.quality).toBe(0.9);
      expect(fromBitmap.quality).toBe(0.9);
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

    it("resolves a cache miss with null, without an error", async () => {
      const onError = vi.fn<(message: string) => void>();
      bridge.setOnError(onError);
      const other = track(bridge.renderThumbnailFromSource(sourceRequest("other")));
      const outcome = track(bridge.renderThumbnailFromSource(sourceRequest("s1")));

      worker.reply({ type: "thumbnailMiss", requestId: "s1", key: "k" });
      await flush();

      expect(outcome.state).toBe("resolved");
      expect(outcome.value).toBeNull();
      expect(other.state).toBe("pending");
      expect(onError).not.toHaveBeenCalled();
    });

    it("rejects renderThumbnailAsync and reports the cause on a thumbnailError", async () => {
      const onError = vi.fn<(message: string) => void>();
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
    });

    it("resolves a from-source thumbnail with null on a thumbnailError", async () => {
      bridge.setOnError(() => undefined);
      const outcome = track(bridge.renderThumbnailFromSource(sourceRequest("s1")));
      worker.reply({ type: "thumbnailError", requestId: "s1", message: "lost context" });
      await flush();

      expect(outcome.state).toBe("resolved");
      expect(outcome.value).toBeNull();
    });

    // renderPhotoFloatFrame's request: a thumbnail read as floats, from a
    // resident source or an image, settled by requestId like any other.
    describe("as floats", () => {
      it("asks for the point and space given, or pre-output in linear Rec.709, with no encoding", () => {
        const asked = { point: "output", space: WIDE } as const;
        const defaults = { point: "pre-output", space: DEFAULT_CAPTURE_SPACE };
        const image = thumbRequest("t1");
        track(bridge.renderThumbnailFloat({ ...sourceRequest("s1"), float: asked }));
        track(bridge.renderThumbnailFloat({ ...sourceRequest("s2"), float: {} }));
        track(bridge.renderThumbnailFloat({ ...image, float: asked }));
        track(bridge.renderThumbnailFloat({ ...thumbRequest("t2"), float: {} }));

        const fromSource = sent(worker, "renderThumbnailFromSource");
        const fromImage = sent(worker, "renderThumbnail");
        expect(fromSource.map((m) => [m.requestId, m.key, m.float])).toEqual([["s1", "k", asked], ["s2", "k", defaults]]);
        expect(fromImage.map((m) => [m.requestId, m.float])).toEqual([["t1", asked], ["t2", defaults]]);
        for (const request of [...fromSource, ...fromImage]) {
          expect(request).not.toHaveProperty("quality");
          expect(request).not.toHaveProperty("lossless");
        }
        // The image is handed over, as renderThumbnail hands it.
        expect(fromImage[0].image).toBe(image.image);
        expect(worker.transfers[worker.posted.indexOf(fromImage[0])]).toEqual([image.image.data.buffer]);
      });

      it("resolves each with its frame, or null, by requestId", async () => {
        const blob = track(bridge.renderThumbnailFromSource(sourceRequest("b")));
        const first = track(bridge.renderThumbnailFloat({ ...sourceRequest("f1"), float: {} }));
        const second = track(bridge.renderThumbnailFloat({ ...thumbRequest("f2"), float: {} }));
        const frame = frameOf("output");

        worker.reply({ type: "thumbnailFloat", requestId: "f2", frame });
        await flush();
        expect([first.state, second.state, blob.state]).toEqual(["pending", "resolved", "pending"]);
        expect(second.value).toBe(frame);

        worker.reply({ type: "thumbnailFloat", requestId: "f1", frame: null });
        await flush();
        expect([first.state, first.value]).toEqual(["resolved", null]);
        expect(blob.state).toBe("pending");
      });

      it("resolves null on a cache miss and on a thumbnailError, reporting the error", async () => {
        const onError = vi.fn<(message: string) => void>();
        bridge.setOnError(onError);
        const miss = track(bridge.renderThumbnailFloat({ ...sourceRequest("s1"), float: {} }));
        const failed = track(bridge.renderThumbnailFloat({ ...thumbRequest("t1"), float: {} }));

        worker.reply({ type: "thumbnailMiss", requestId: "s1", key: "k" });
        worker.reply({ type: "thumbnailError", requestId: "t1", message: "lost context" });
        await flush();

        expect([miss.state, miss.value, failed.state, failed.value]).toEqual(["resolved", null, "resolved", null]);
        expect(onError).toHaveBeenCalledWith("thumbnail render failed: lost context");
      });

      it("resolves null, posting nothing, once the bridge is disposed", async () => {
        bridge.dispose();
        const late = track(bridge.renderThumbnailFloat({ ...sourceRequest("s1"), float: {} }));
        await flush();
        expect([late.state, late.value]).toEqual(["resolved", null]);
        expect(sent(worker, "renderThumbnailFromSource")).toEqual([]);
      });

      it("takes a resident source's key or an image, and types both together as an error", () => {
        // With both, "key" wins and the image is cloned into a post that ignores it.
        const both = { ...sourceRequest("s1"), ...thumbRequest("t1"), float: {} };
        // @ts-expect-error: key and image are exclusive
        const ask = () => bridge.renderThumbnailFloat(both);
        expect(ask).toBeTypeOf("function");
      });
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
      bridge.uploadSource("main", "b", image(), undefined, false, false);
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

    it("sends a bag patch only when asked for one", () => {
      void bridge.capture(params);
      void bridge.capture(params, { paramBag: { "a.mode": 1 } });
      const [plain, patched] = sent(worker, "capture");
      expect("bagPatch" in plain).toBe(false);
      expect(patched.bagPatch).toEqual({ "a.mode": 1 });
    });
  });

  describe("float capture", () => {
    it("asks for pre-output in linear Rec.709 unless told otherwise, with a bag patch only when given one", () => {
      void bridge.captureFloat(params);
      void bridge.captureFloat(params, { point: "output", space: WIDE, paramBag: { "a.mode": 1 } });
      const [plain, asked] = sent(worker, "captureFloat");
      expect(plain.params).toBe(params);
      expect([plain.point, plain.space, "bagPatch" in plain]).toEqual(["pre-output", DEFAULT_CAPTURE_SPACE, false]);
      expect([asked.point, asked.space, asked.bagPatch]).toEqual(["output", WIDE, { "a.mode": 1 }]);
    });

    // A frame at the Develop render resolution is about 180 MB of floats and a
    // second of worker time, so the full view is asked for, never defaulted to.
    it("asks for 1280 px on the long edge unless given an edge, Infinity for the full view", () => {
      for (const maxEdge of [undefined, 2000, Infinity, Number.NaN, 0, -640]) {
        void bridge.captureFloat(params, maxEdge === undefined ? {} : { maxEdge });
      }
      expect(sent(worker, "captureFloat").map((m) => m.maxEdge)).toEqual([1280, 2000, Infinity, 1280, 1280, 1280]);
    });

    it("resolves the transferred frame, matched by reqId, or null when the worker had none", async () => {
      const first = track(bridge.captureFloat(params));
      const second = track(bridge.captureFloat(params, { point: "output" }));
      const [one, two] = sent(worker, "captureFloat");
      const frame = frameOf("output");

      worker.reply({ type: "capturedFloat", reqId: 999, frame: frameOf("pre-output") });
      worker.reply({ type: "capturedFloat", reqId: two.reqId, frame });
      await flush();
      expect([first.state, second.state]).toEqual(["pending", "resolved"]);
      expect(second.value).toBe(frame);

      worker.reply({ type: "capturedFloat", reqId: one.reqId, frame: null });
      await flush();
      expect(first.state).toBe("resolved");
      expect(first.value).toBeNull();
    });

    // A terminated worker never answers, and the extension awaits its frame.
    it("settles a float capture pending at dispose, and one asked after, with null", async () => {
      const pending = track(bridge.captureFloat(params));
      bridge.dispose();
      const late = track(bridge.captureFloat(params));
      await flush();
      expect([pending.state, late.state]).toEqual(["resolved", "resolved"]);
      expect([pending.value, late.value]).toEqual([null, null]);
      expect(sent(worker, "captureFloat")).toHaveLength(1);
    });

    it("reaches extensions as api.develop.captureFloatFrame, through the shared bridge", async () => {
      try {
        const asked = track(
          makeScopedAPI("test.float").develop.captureFloatFrame(params, { point: "output", maxEdge: 640 }),
        );
        const shared = FakeWorker.instances.at(-1);
        if (!shared || shared === worker) throw new Error("the shared bridge made no worker");
        const [request] = sent(shared, "captureFloat");
        expect([request.params, request.point, request.maxEdge]).toEqual([params, "output", 640]);
        const frame = frameOf("output");
        shared.reply({ type: "capturedFloat", reqId: request.reqId, frame });
        await flush();
        expect(asked.value).toBe(frame);
      } finally {
        disposeRenderBridge();
      }
    });

    it("reaches extensions as api.develop.renderPhotoFloatFrame, for a catalogue photo, through the shared bridge", async () => {
      const photos = useCatalogStore.getState().photos;
      useCatalogStore.setState({ photos: [photoFixture("p1")] });
      try {
        const asked = track(
          makeScopedAPI("test.float").develop.renderPhotoFloatFrame("p1", params, { point: "output", space: WIDE }),
        );
        const shared = FakeWorker.instances.at(-1);
        if (!shared || shared === worker) throw new Error("the shared bridge made no worker");
        shared.reply({ type: "ready", pipelineFloat: true });
        await vi.waitFor(() => expect(sent(shared, "renderThumbnailFromSource")).toHaveLength(1));
        const [request] = sent(shared, "renderThumbnailFromSource");
        expect([request.params, request.maxEdge, request.float]).toEqual([params, 640, { point: "output", space: WIDE }]);
        const frame = frameOf("output");
        shared.reply({ type: "thumbnailFloat", requestId: request.requestId, frame });
        await vi.waitFor(() => expect(asked.state).toBe("resolved"));
        expect(asked.value).toBe(frame);
      } finally {
        disposeRenderBridge();
        useCatalogStore.setState({ photos });
      }
    });
  });

  describe("probe", () => {
    it("asks for the point it is given and resolves with the colour, matched by reqId", async () => {
      const output = track(bridge.probe(0.25, 0.5, "output"));
      const mask = track(bridge.probe(0.75, 0.5, "mask"));
      const [one, two] = sent(worker, "probe");
      expect([one.u, one.v, one.point, two.u, two.v, two.point]).toEqual([0.25, 0.5, "output", 0.75, 0.5, "mask"]);

      worker.reply({ type: "probed", reqId: 999, rgb: [1, 1, 1] });
      worker.reply({ type: "probed", reqId: two.reqId, rgb: [-0.2, 0.6, -0.1] });
      await flush();
      expect([output.state, mask.state]).toEqual(["pending", "resolved"]);
      expect(mask.value).toEqual([-0.2, 0.6, -0.1]);

      // The worker had nothing to read: no renderer, or no source.
      worker.reply({ type: "probed", reqId: one.reqId, rgb: null });
      await flush();
      expect(output.state).toBe("resolved");
      expect(output.value).toBeNull();
    });

    // A terminated worker never answers, and a white balance pick awaits one.
    it("settles a probe pending at dispose, and one asked after, with null", async () => {
      const pending = track(bridge.probe(0.5, 0.5, "output"));
      bridge.dispose();
      const late = track(bridge.probe(0.5, 0.5, "mask"));
      await flush();
      expect([pending.state, late.state]).toEqual(["resolved", "resolved"]);
      expect([pending.value, late.value]).toEqual([null, null]);
      expect(sent(worker, "probe")).toHaveLength(1);
    });
  });

  describe("source sample", () => {
    const sampleOf = (x: number): SourceSample => ({
      data: new Float32Array([1, 2, 3, 1]),
      width: 1,
      height: 1,
      x,
      y: 20,
      sourceWidth: 3000,
      sourceHeight: 2000,
    });

    it("asks for the sample and resolves with the reply carrying its reqId", async () => {
      const first = track(bridge.readSourceSample());
      const second = track(bridge.readSourceSample());
      const [one, two] = sent(worker, "readSourceSample");
      expect(sent(worker, "readSourceSample")).toHaveLength(2);
      expect(one.reqId).not.toBe(two.reqId);

      // A reply nobody is waiting for settles nothing and throws nothing.
      expect(() => worker.reply({ type: "sourceSample", reqId: 999, sample: sampleOf(1) })).not.toThrow();
      await flush();
      expect([first.state, second.state]).toEqual(["pending", "pending"]);

      const sample = sampleOf(10);
      worker.reply({ type: "sourceSample", reqId: two.reqId, sample });
      await flush();
      expect([first.state, second.state]).toEqual(["pending", "resolved"]);
      expect(second.value).toBe(sample);

      // The worker had nothing to cut one from.
      worker.reply({ type: "sourceSample", reqId: one.reqId, sample: null });
      await flush();
      expect(first.state).toBe("resolved");
      expect(first.value).toBeNull();
    });

    // A terminated worker never answers, and a measuring extension awaits one.
    it("settles a read pending at dispose, and one asked after, with null", async () => {
      const pending = track(bridge.readSourceSample());
      bridge.dispose();
      const late = track(bridge.readSourceSample());
      await flush();
      expect([pending.state, late.state]).toEqual(["resolved", "resolved"]);
      expect([pending.value, late.value]).toEqual([null, null]);
      expect(sent(worker, "readSourceSample")).toHaveLength(1);
    });
  });

  // The developed frame of the whole image, untransformed and uncropped, at a
  // small size: what Transform's Upright detects lines in.
  describe("the developed pixels", () => {
    it("resolves with the pixels the worker read, at the edge asked for", async () => {
      const outcome = track(bridge.readDevelopedPixels(256));
      const [request] = sent(worker, "readDevelopedPixels");
      expect(request.edge).toBe(256);

      const read = pixels(256, 171);
      worker.reply({ type: "developedPixels", reqId: request.reqId, pixels: read });
      await flush();

      expect(outcome.state).toBe("resolved");
      expect(outcome.value).toBe(read);
    });

    it("settles each read by its reqId, whatever order the replies come in", async () => {
      const first = track(bridge.readDevelopedPixels(256));
      const second = track(bridge.readDevelopedPixels(128));
      const [firstRequest, secondRequest] = sent(worker, "readDevelopedPixels");

      worker.reply({ type: "developedPixels", reqId: secondRequest.reqId, pixels: null });
      await flush();
      expect([first.state, second.state]).toEqual(["pending", "resolved"]);
      expect(second.value).toBeNull();

      const read = pixels(4, 2);
      worker.reply({ type: "developedPixels", reqId: firstRequest.reqId, pixels: read });
      await flush();
      expect(first.value).toBe(read);
    });

    it("settles a read with null when it fails, and reports it", async () => {
      const onError = vi.fn<(message: string) => void>();
      bridge.setOnError(onError);
      const other = track(bridge.readDevelopedPixels(256));
      const outcome = track(bridge.readDevelopedPixels(256));
      const [, request] = sent(worker, "readDevelopedPixels");

      worker.reply({ type: "developedPixelsError", reqId: request.reqId, message: "context lost" });
      await flush();

      expect(outcome.state).toBe("resolved");
      expect(outcome.value).toBeNull();
      expect(other.state).toBe("pending");
      expect(onError).toHaveBeenCalledWith("reading the developed frame failed: context lost");
    });
  });

  describe("source pixels, errors and the worker's own failure", () => {
    it("hands the source pixels and their size to onSourcePixels", () => {
      const onSourcePixels =
        vi.fn<(src: { data: Uint8ClampedArray; width: number; height: number }) => void>();
      bridge.setOnSourcePixels(onSourcePixels);
      const data = new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255]);
      worker.reply({ type: "sourcePixels", sourceGen: 0, data, width: 3, height: 1 });

      expect(onSourcePixels).toHaveBeenCalledTimes(1);
      const [src] = onSourcePixels.mock.calls[0];
      expect(src.data).toBe(data);
      expect(src.width).toBe(3);
      expect(src.height).toBe(1);
    });

    // Between photos, a search of the source pixels would find the photo before.
    it("clears the window's source pixels when the source is cleared", () => {
      setSourcePixels(new Uint8ClampedArray([1, 2, 3, 255]), 1, 1);
      bridge.clearSource();
      expect(sourcePixels()).toBeNull();
    });

    const tinySource = () => ({ kind: "float16" as const, data: new Uint16Array(4), width: 1, height: 1 });
    const pixelsOf = (sourceGen: number): WorkerResponse => ({
      type: "sourcePixels",
      sourceGen,
      data: new Uint8ClampedArray([sourceGen, 0, 0, 255]),
      width: 1,
      height: 1,
    });

    it("hands over only the source pixels of the source handed over last", () => {
      const onSourcePixels = vi.fn<(src: { data: Uint8ClampedArray; width: number; height: number }) => void>();
      bridge.setOnSourcePixels(onSourcePixels);
      bridge.setImage(tinySource());
      worker.reply(pixelsOf(0));
      expect(onSourcePixels).not.toHaveBeenCalled();

      worker.reply(pixelsOf(1));
      expect(onSourcePixels.mock.calls.map(([src]) => src.data[0])).toEqual([1]);
    });

    it("drops source pixels still on their way when the source was cleared", () => {
      const onSourcePixels = vi.fn<(src: { data: Uint8ClampedArray; width: number; height: number }) => void>();
      bridge.setOnSourcePixels(onSourcePixels);
      bridge.setImage(tinySource());
      bridge.clearSource();
      worker.reply(pixelsOf(1));
      expect(onSourcePixels).not.toHaveBeenCalled();

      bridge.setImage(tinySource());
      worker.reply(pixelsOf(2));
      expect(onSourcePixels.mock.calls.map(([src]) => src.data[0])).toEqual([2]);
    });

    it("hands the number of a source the worker couldn't take to onSourceError, and reports it", () => {
      const onSourceError = vi.fn<(sourceGen: number, message: string) => void>();
      const onError = vi.fn<(message: string) => void>();
      bridge.setOnSourceError(onSourceError);
      bridge.setOnError(onError);
      worker.reply({ type: "sourceError", sourceGen: 4, message: "texImage2D failed" });

      expect(onSourceError).toHaveBeenCalledTimes(1);
      expect(onSourceError).toHaveBeenCalledWith(4, "texImage2D failed");
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
      const upright = track(bridge.readDevelopedPixels(256));
      const ids = {
        bind: sent(worker, "bindSource")[0].reqId,
        has: sent(worker, "hasSource")[0].reqId,
        capture: sent(worker, "capture")[0].reqId,
        upright: sent(worker, "readDevelopedPixels")[0].reqId,
      };
      expect(new Set(Object.values(ids)).size).toBe(4);
      const pending = () => [bind.state, has.state, capture.state, upright.state];

      // Ids nobody issued, and each reply type carrying another kind's id.
      expect(() => {
        worker.reply({ type: "sourceBound", reqId: 999, hit: true });
        worker.reply({ type: "hasSource", reqId: 999, has: true });
        worker.reply({ type: "captured", reqId: 999, bitmap: bitmapOf(1) });
        worker.reply({ type: "developedPixels", reqId: 999, pixels: null });
        worker.reply({ type: "sourceBound", reqId: ids.has, hit: true });
        worker.reply({ type: "hasSource", reqId: ids.capture, has: true });
        worker.reply({ type: "captured", reqId: ids.upright, bitmap: bitmapOf(1) });
        worker.reply({ type: "developedPixels", reqId: ids.bind, pixels: null });
      }).not.toThrow();
      await flush();
      expect(pending()).toEqual(["pending", "pending", "pending", "pending"]);

      worker.reply({ type: "sourceBound", reqId: ids.bind, hit: true });
      worker.reply({ type: "hasSource", reqId: ids.has, has: true });
      worker.reply({ type: "captured", reqId: ids.capture, bitmap: bitmapOf(1) });
      worker.reply({ type: "developedPixels", reqId: ids.upright, pixels: null });
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

    it("settles no pending read of the developed pixels for another reqId, and still reports a failure", async () => {
      const onError = vi.fn<(message: string) => void>();
      bridge.setOnError(onError);
      const outcome = track(bridge.readDevelopedPixels(256));
      const [request] = sent(worker, "readDevelopedPixels");

      worker.reply({ type: "developedPixelsError", reqId: request.reqId + 100, message: "stale" });
      await flush();

      expect(outcome.state).toBe("pending");
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith("reading the developed frame failed: stale");

      worker.reply({ type: "developedPixels", reqId: request.reqId, pixels: null });
      await flush();
      expect(outcome.state).toBe("resolved");
    });
  });

  // On a machine where WebGL2 can't start, or a worker that is gone, nothing that
  // waits on the bridge may wait for good: it goes on with what a failure answers.
  describe("when the worker can't answer", () => {
    const askEverything = () => ({
      fromSource: track(bridge.renderThumbnailFromSource(sourceRequest("s1"))),
      direct: track(bridge.renderThumbnailAsync(thumbRequest("t1"))),
      float: track(bridge.renderThumbnailFloat({ ...sourceRequest("f1"), float: {} })),
      bound: track(bridge.bindSource("k")),
      has: track(bridge.hasSource("main", "k")),
      capture: track(bridge.capture(params)),
      floatCapture: track(bridge.captureFloat(params)),
      sample: track(bridge.readSourceSample()),
      probe: track(bridge.probe(0.5, 0.5, "output")),
      pixels: track(bridge.readDevelopedPixels(256)),
    });
    type Asked = ReturnType<typeof askEverything>;
    const states = (asked: Asked) => Object.values(asked).map((outcome) => outcome.state);
    const expectNoResults = (asked: Asked) => {
      expect(asked.direct.state).toBe("rejected");
      const { direct, capture, ...rest } = asked;
      expect(Object.values(rest).map((outcome) => outcome.state)).not.toContain("pending");
      expect(Object.values(rest).map((outcome) => outcome.value)).toEqual([
        null, null, false, false, null, null, null, null,
      ]);
      expect([capture.state, capture.value?.width, capture.value?.height]).toEqual(["resolved", 1, 1]);
      expect(direct.reason).toMatchObject({ message: "thumbnail render failed" });
    };

    beforeEach(() => {
      vi.useFakeTimers();
      bridge.setOnError(() => undefined);
    });

    afterEach(() => {
      bridge.dispose();
      vi.useRealTimers();
    });

    it("settles ready, and every request waiting, once the retry budget is spent", async () => {
      const ready = track(bridge.ready);
      bridge.init(64, 64);
      while (inits(worker).length < 10) {
        worker.reply(initError);
        vi.advanceTimersByTime(30_000);
      }
      const asked = askEverything();
      await flush();
      expect(ready.state).toBe("pending");
      expect(states(asked)).toEqual(Array(10).fill("pending"));

      worker.reply(initError);
      await flush();

      expect(bridge.availability).toBe("failed");
      expect(ready.state).toBe("resolved");
      expect(bridge.pipelineFloat).toBeUndefined();
      expectNoResults(asked);
    });

    it("fails on the worker's own error event, settling ready and every request waiting", async () => {
      const onError = vi.fn<(message: string) => void>();
      bridge.setOnError(onError);
      const seen: Array<[string, string | undefined]> = [];
      bridge.setOnAvailability((availability, detail) => seen.push([availability, detail]));
      const ready = track(bridge.ready);
      bridge.init(64, 64);
      const asked = askEverything();

      worker.onerror?.(new ErrorEvent("error", { message: "Failed to fetch module" }));
      await flush();

      expect(seen.at(-1)).toEqual(["failed", "Failed to fetch module"]);
      expect(onError).toHaveBeenCalledWith("Failed to fetch module");
      expect(ready.state).toBe("resolved");
      expectNoResults(asked);
    });

    it("stops retrying a failing init on the worker's error event", () => {
      bridge.init(64, 64);
      worker.reply(initError);
      worker.onerror?.(new ErrorEvent("error", { message: "gone" }));
      vi.advanceTimersByTime(600_000);
      expect(inits(worker)).toHaveLength(1);
      expect(bridge.availability).toBe("failed");
    });

    it("settles ready, every request waiting at dispose, and every one asked after", async () => {
      const ready = track(bridge.ready);
      const asked = askEverything();
      bridge.dispose();
      const late = askEverything();
      await flush();

      expect(ready.state).toBe("resolved");
      expectNoResults(asked);
      expectNoResults(late);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("answers a request asked once the bridge has failed at once, and posts nothing to the worker", async () => {
      bridge.init(64, 64);
      worker.onerror?.(new ErrorEvent("error", { message: "gone" }));
      const before = worker.posted.length;
      const asked = askEverything();
      bridge.setParams(params);
      bridge.render();
      await flush();

      expectNoResults(asked);
      expect(worker.posted).toHaveLength(before);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("gives up on a request once the worker has said nothing for 30 s", async () => {
      const asked = askEverything();
      // A full-view float capture, or a large read of the developed frame, is one long
      // job on a software renderer, during which the worker says nothing: not timed by it.
      const { floatCapture, pixels, ...timed } = asked;
      const frame = frameOf("pre-output");
      worker.reply({ type: "capturedFloat", reqId: sent(worker, "captureFloat")[0].reqId, frame });
      worker.reply({ type: "developedPixels", reqId: sent(worker, "readDevelopedPixels")[0].reqId, pixels: null });
      vi.advanceTimersByTime(29_999);
      await flush();
      expect([floatCapture.value, pixels.state]).toEqual([frame, "resolved"]);
      expect(Object.values(timed).map((outcome) => outcome.state)).toEqual(Array(8).fill("pending"));

      vi.advanceTimersByTime(1);
      await flush();
      expect(Object.values(timed).map((outcome) => outcome.state)).not.toContain("pending");
      expect([timed.probe.value, timed.sample.value, timed.fromSource.value]).toEqual([null, null, null]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("doesn't count the worker's silence while it works on a request that isn't timed", async () => {
      const long = track(bridge.captureFloat(params, { maxEdge: Infinity }));
      const queued = track(bridge.probe(0.5, 0.5, "output"));
      vi.advanceTimersByTime(90_000);
      await flush();
      expect([long.state, queued.state]).toEqual(["pending", "pending"]);

      worker.reply({ type: "capturedFloat", reqId: sent(worker, "captureFloat")[0].reqId, frame: null });
      vi.advanceTimersByTime(29_999);
      await flush();
      expect(queued.state).toBe("pending");
      vi.advanceTimersByTime(1);
      await flush();
      expect([queued.state, queued.value]).toEqual(["resolved", null]);
    });

    it("counts the silence again once a long request has run for 5 minutes, and gives up on it too", async () => {
      const long = track(bridge.captureFloat(params, { maxEdge: Infinity }));
      const queued = track(bridge.probe(0.5, 0.5, "output"));
      vi.advanceTimersByTime(290_000);
      await flush();
      expect([long.state, queued.state]).toEqual(["pending", "pending"]);

      vi.advanceTimersByTime(40_000);
      await flush();
      expect([long.state, long.value, queued.state, queued.value]).toEqual(["resolved", null, "resolved", null]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("only reports an error event once the worker is ready, and goes on rendering", async () => {
      const onError = vi.fn<(message: string) => void>();
      bridge.setOnError(onError);
      bridge.init(64, 64);
      worker.reply({ type: "ready", pipelineFloat: true });
      const waiting = track(bridge.probe(0.5, 0.5, "output"));

      worker.onerror?.(new ErrorEvent("error", { message: "Uncaught TypeError in a timer" }));
      await flush();

      expect(onError).toHaveBeenCalledWith("Uncaught TypeError in a timer");
      expect(bridge.availability).toBe("ready");
      expect(waiting.state).toBe("pending");
      const asked = track(bridge.probe(0.25, 0.25, "output"));
      expect(sent(worker, "probe")).toHaveLength(2);
      worker.reply({ type: "probed", reqId: sent(worker, "probe")[1].reqId, rgb: [1, 1, 1] });
      await flush();
      expect(asked.value).toEqual([1, 1, 1]);
    });

    it("closes the bitmap of a capture answered after it was given up on, or never asked", async () => {
      const close = vi.fn();
      const late = { width: 4, height: 3, close };
      const stray = { width: 4, height: 3, close: vi.fn() };
      const given = track(bridge.capture(params));
      vi.advanceTimersByTime(30_000);
      await flush();
      expect(given.value).toMatchObject({ width: 1, height: 1 });

      worker.reply({ type: "captured", reqId: sent(worker, "capture")[0].reqId, bitmap: late });
      worker.reply({ type: "captured", reqId: 999, bitmap: stray });
      expect(close).toHaveBeenCalledTimes(1);
      expect(stray.close).toHaveBeenCalledTimes(1);
    });

    it("keeps waiting while the worker answers other requests, as a long queue of thumbnails does", async () => {
      const waiting = track(bridge.probe(0.5, 0.5, "output"));
      for (let i = 0; i < 6; i++) {
        vi.advanceTimersByTime(10_000);
        worker.reply({ type: "thumbnailMiss", requestId: `other-${i}`, key: "k" });
      }
      await flush();
      expect(waiting.state).toBe("pending");

      vi.advanceTimersByTime(30_000);
      await flush();
      expect([waiting.state, waiting.value]).toEqual(["resolved", null]);
    });

    it("leaves no timer behind for a request answered in time, and settles it with the answer", async () => {
      const answered = track(bridge.probe(0.5, 0.5, "output"));
      const [request] = sent(worker, "probe");
      worker.reply({ type: "probed", reqId: request.reqId, rgb: [1, 2, 3] });
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(60_000);
      await flush();
      expect(answered.value).toEqual([1, 2, 3]);
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

  // A frame can put off mask copies' prepasses to the frames after it; those
  // come with no new edit to ask for them.
  describe("a frame that leaves prepasses pending", () => {
    const pending = (seq: number): WorkerResponse => ({ ...frameFor(seq), prepassPending: true }) as WorkerResponse;

    it("is followed by another render, asking what it asked", () => {
      bridge.render(true, true);
      worker.reply(pending(inFlight(worker)));
      expect(renders(worker)).toHaveLength(2);
      expect(renders(worker)[1]).toMatchObject({ wantHistogram: true, wantExtended: true });
    });

    it("lets the render that waits be that render", () => {
      bridge.render();
      bridge.render(true);
      worker.reply(pending(inFlight(worker)));
      expect(renders(worker)).toHaveLength(2);
      expect(renders(worker)[1]).toMatchObject({ wantHistogram: true });
    });

    it("isn't followed by one when nothing is pending", () => {
      bridge.render();
      worker.reply(frameFor(inFlight(worker)));
      expect(renders(worker)).toHaveLength(1);
    });
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
      worker.reply({ type: "sourcePixels", sourceGen: 0, data: new Uint8ClampedArray(4), width: 1, height: 1 });

      vi.advanceTimersByTime(29_999);
      expect(renders(worker)).toHaveLength(2);
      vi.advanceTimersByTime(1);
      expect(renders(worker)).toHaveLength(3);
    });

    // The backstop sending a render is not the worker speaking: a hung worker that keeps
    // being asked for renders still lets its other requests go.
    it("settles a request 30 s after the worker last spoke, while renders keep being asked for", async () => {
      bridge.render();
      bridge.render();
      vi.advanceTimersByTime(2_000);
      let probed: [number, number, number] | null | "pending" = "pending";
      void bridge.probe(0.5, 0.5, "output").then((rgb) => (probed = rgb));
      const asking = setInterval(() => bridge.render(), 1_000);

      await vi.advanceTimersByTimeAsync(29_999);
      expect(probed).toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      expect(renders(worker).length).toBeGreaterThan(2);
      expect(probed).toBeNull();
      clearInterval(asking);
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

  // A worker that has hung, or died without a word, says nothing while renders wait for
  // it. Past two backstops in a row with no word from it, a minute, Develop says it can't
  // show images, and whoever waits is let go; the worker's next word makes it ready again.
  describe("when the worker stops answering", () => {
    let seen: [string, string | undefined][];

    beforeEach(() => {
      ready(worker);
      seen = [];
      bridge.setOnAvailability((availability, detail) => seen.push([availability, detail]));
    });

    /** Renders asked for through `ms` of the worker saying nothing, one a second. */
    async function askThrough(ms: number) {
      for (let t = 0; t < ms; t += 1_000) {
        bridge.render();
        await vi.advanceTimersByTimeAsync(1_000);
      }
    }

    it("calls it unresponsive after a minute of silence with renders waiting, and settles what waits", async () => {
      await askThrough(45_000);
      let probed: [number, number, number] | null | "pending" = "pending";
      void bridge.probe(0.5, 0.5, "output").then((rgb) => (probed = rgb));
      await askThrough(14_000);
      expect(bridge.availability).toBe("ready");
      expect(probed).toBe("pending");

      await askThrough(1_000);
      expect(bridge.availability).toBe("unresponsive");
      expect(seen.at(-1)).toEqual(["unresponsive", "the renderer stopped responding"]);
      expect(probed).toBeNull();
    });

    // A full-view float read on a software renderer is one long job the worker says
    // nothing during, and the renders asked for meanwhile queue behind it.
    it("stays ready through a long request's silence, and counts it once the request's 5 minutes are up", async () => {
      let read: FloatFrame | null | "pending" = "pending";
      void bridge.captureFloat(normalizeParams({}), { maxEdge: Infinity }).then((frame) => (read = frame));

      await askThrough(90_000);
      expect(bridge.availability).toBe("ready");
      await askThrough(209_000);
      expect(bridge.availability).toBe("ready");
      expect(read).toBe("pending");

      await askThrough(70_000);
      expect(bridge.availability).toBe("unresponsive");
      expect(read).toBeNull();
    });

    it("is ready again once the worker speaks, and sends the next render once it answers", async () => {
      await askThrough(60_000);
      expect(bridge.availability).toBe("unresponsive");
      const posted = renders(worker).length;

      worker.reply(frameFor(renders(worker)[0].seq));
      expect(bridge.availability).toBe("ready");
      expect(seen.at(-1)).toEqual(["ready", undefined]);
      bridge.render();
      expect(renders(worker)).toHaveLength(posted);
      worker.reply(frameFor(inFlight(worker)));
      expect(renders(worker)).toHaveLength(posted + 1);
    });

    it("does not call a worker unresponsive that spoke between the backstops", async () => {
      await askThrough(40_000);
      worker.reply({ type: "sourcePixels", sourceGen: 0, data: new Uint8ClampedArray(4), width: 1, height: 1 });
      await askThrough(59_000);
      expect(bridge.availability).toBe("ready");
      await askThrough(1_000);
      expect(bridge.availability).toBe("unresponsive");
    });

    it("does not call a slow worker unresponsive that answers each render within 30 s", async () => {
      for (let i = 0; i < 6; i++) {
        bridge.render();
        bridge.render();
        await vi.advanceTimersByTimeAsync(25_000);
        worker.reply(frameFor(renders(worker).at(-2)!.seq));
        worker.reply(frameFor(inFlight(worker)));
      }
      expect(seen).toEqual([["ready", undefined]]);
    });

    it("only logs an error event while it is unresponsive, and recovers all the same", async () => {
      const onError = vi.fn<(message: string) => void>();
      bridge.setOnError(onError);
      await askThrough(60_000);
      worker.onerror?.(new ErrorEvent("error", { message: "Uncaught TypeError in a timer" }));
      expect(onError).toHaveBeenCalledWith("Uncaught TypeError in a timer");
      expect(bridge.availability).toBe("unresponsive");
      worker.reply(frameFor(inFlight(worker)));
      expect(bridge.availability).toBe("ready");
    });
  });

  // A GPU reset loses the worker's graphics context. The worker says so, draws nothing
  // until the context is restored, and says ready again once its renderer is rebuilt.
  describe("when the worker's graphics context is lost", () => {
    let seen: [string, string | undefined][];

    beforeEach(() => {
      ready(worker);
      seen = [];
      bridge.setOnAvailability((availability, detail) => seen.push([availability, detail]));
    });

    it("says so, and posts no render until the worker is ready again", () => {
      bridge.render();
      worker.reply({ type: "contextLost" });
      expect(bridge.availability).toBe("lost");
      expect(seen.at(-1)).toEqual(["lost", "the graphics context was lost"]);

      bridge.render();
      vi.advanceTimersByTime(120_000);
      expect(renders(worker)).toHaveLength(1);
      expect(warn).not.toHaveBeenCalled();
      bridge.setParams(normalizeParams({}));
      expect(worker.posted.at(-1)).toMatchObject({ cmd: "setParams" });

      ready(worker);
      expect(bridge.availability).toBe("ready");
      bridge.render();
      expect(renders(worker)).toHaveLength(2);
    });

    it("stays lost, not ready, while the worker answers what it was asked before", () => {
      bridge.render();
      const seq = inFlight(worker);
      worker.reply({ type: "contextLost" });
      worker.reply({ type: "frameSkipped", seq });
      expect(bridge.availability).toBe("lost");
    });

    it("only logs an error event while lost", () => {
      const onError = vi.fn<(message: string) => void>();
      bridge.setOnError(onError);
      worker.reply({ type: "contextLost" });
      worker.onerror?.(new ErrorEvent("error", { message: "Uncaught TypeError in a timer" }));
      expect(onError).toHaveBeenCalledWith("Uncaught TypeError in a timer");
      expect(bridge.availability).toBe("lost");
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

// A Linux display profile reaches the worker for the live view. Captures stay
// sRGB, since extensions measure them, unless one asks for the frame as shown.
describe("RenderBridge display profile", () => {
  const DISPLAY: MonitorTransform = {
    matrix: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
    curve: "gamma22",
  };
  const ACTIVE: DisplayProfileState = {
    status: "active",
    path: "/monitor.icc",
    description: "Monitor",
    transform: DISPLAY,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
    useDisplayProfile.setState({ status: "off" }, true);
  });

  afterEach(() => {
    disposeRenderBridge();
    useDisplayProfile.setState({ status: "off" }, true);
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const transforms = (worker: FakeWorker) =>
    worker.posted.flatMap((m) => (m.cmd === "setMonitorTransform" ? [m.transform] : []));

  it("hands the worker the profile active when it starts, and follows it", () => {
    useDisplayProfile.setState(ACTIVE, true);
    getRenderBridge();
    const worker = FakeWorker.instances[0];
    expect(transforms(worker)).toEqual([DISPLAY]);

    useDisplayProfile.setState({ status: "loading", path: "/other.icc" }, true);
    useDisplayProfile.setState({ status: "error", path: "/other.icc", error: "no" }, true);
    expect(transforms(worker)).toEqual([DISPLAY, null]);
  });

  it("tells the worker nothing while there is no profile", () => {
    getRenderBridge();
    useDisplayProfile.setState({ status: "loading", path: "/monitor.icc" }, true);
    expect(transforms(FakeWorker.instances[0])).toEqual([]);
  });

  it("redraws the view with a new profile", () => {
    const render = vi.spyOn(RenderBridge.prototype, "render");
    getRenderBridge();
    useDisplayProfile.setState(ACTIVE, true);
    vi.advanceTimersByTime(50);
    expect(render).toHaveBeenCalledWith(false);
  });

  it("captures in sRGB unless asked for the frame as shown", () => {
    const bridge = new RenderBridge();
    const worker = FakeWorker.instances[0];
    void bridge.capture(normalizeParams({}));
    void bridge.capture(normalizeParams({}), { asShown: true });
    const asked = worker.posted.flatMap((m) => (m.cmd === "capture" ? [m.asShown] : []));
    expect(asked).toEqual([false, true]);
    bridge.dispose();
  });
});

// A wide-gamut screen reaches the worker for the live view, as a Linux display
// profile does, and a screen change (a window dragged to another monitor)
// redraws it.
describe("RenderBridge display space", () => {
  /** A screen whose `(color-gamut: p3)` query can be flipped, with its listeners. */
  function stubScreen(p3: boolean) {
    const listeners = new Set<() => void>();
    const query = {
      matches: p3,
      addEventListener: (_type: string, fn: () => void) => void listeners.add(fn),
      removeEventListener: (_type: string, fn: () => void) => void listeners.delete(fn),
    };
    vi.stubGlobal("matchMedia", () => query);
    return {
      listeners,
      moveTo(next: boolean) {
        query.matches = next;
        for (const fn of [...listeners]) fn();
      },
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
  });

  afterEach(() => {
    disposeRenderBridge();
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const spaces = (worker: FakeWorker) =>
    worker.posted.flatMap((m) => (m.cmd === "setDisplaySpace" ? [m.space] : []));

  it("hands the worker the P3 space a screen has when it starts", () => {
    stubScreen(true);
    getRenderBridge();
    expect(spaces(FakeWorker.instances[0])).toEqual(["display-p3"]);
  });

  it("tells the worker nothing while the screen is sRGB", () => {
    stubScreen(false);
    getRenderBridge();
    expect(spaces(FakeWorker.instances[0])).toEqual([]);
  });

  it("follows the screen and redraws the view", () => {
    const screen = stubScreen(false);
    const render = vi.spyOn(RenderBridge.prototype, "render");
    getRenderBridge();
    screen.moveTo(true);
    vi.advanceTimersByTime(50);
    expect(spaces(FakeWorker.instances[0])).toEqual(["display-p3"]);
    expect(render).toHaveBeenCalledWith(false);

    screen.moveTo(false);
    expect(spaces(FakeWorker.instances[0])).toEqual(["display-p3", "srgb"]);
  });

  it("stops following the screen once disposed", () => {
    const screen = stubScreen(false);
    getRenderBridge();
    expect(screen.listeners.size).toBe(1);
    disposeRenderBridge();
    expect(screen.listeners.size).toBe(0);
  });
});

describe("RenderBridge proof", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("hands the worker the proof space, and its turning off", () => {
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
    const bridge = new RenderBridge();
    bridge.setProof("adobe-rgb");
    bridge.setProof(null);
    const proofs = FakeWorker.instances[0].posted.flatMap((m) => (m.cmd === "setProof" ? [m.space] : []));
    expect(proofs).toEqual(["adobe-rgb", null]);
    bridge.dispose();
  });
});

describe("RenderBridge transform derived uniforms", () => {
  const TUNED = {
    id: "test.tuned",
    name: "Tuned",
    glsl: "vec3 pipelineToDisplay(vec3 lin) { return twice * lin; }",
    params: [{ key: "gain", glslType: "float" as const, default: 1 }],
    derive: {
      uniforms: [{ key: "twice", glslType: "float" as const, default: 2 }],
      fn: (v: Readonly<Record<string, number | number[] | boolean>>) => ({ twice: 2 * (v.gain as number) }),
    },
  };
  const tuned = normalizeParams({ displayTransform: TUNED.id });

  beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
    useRegistry.setState({ pipelines: {} });
    registerPipeline("core", { id: DEFAULT_PIPELINE, name: "Built-in" });
    registerPipeline("test", TUNED);
    usePipelineStore.setState({ activeId: DEFAULT_PIPELINE });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    unregisterExtension("test");
    useRegistry.setState({ pipelines: {} });
  });

  type BagPost = Extract<WorkerRequest, { cmd: "setContributedParams" | "patchContributedParams" }>;
  const bagPosts = (worker: FakeWorker) =>
    worker.posted.filter((m): m is BagPost => m.cmd === "setContributedParams" || m.cmd === "patchContributedParams");

  it("adds the live transform's derived uniforms to the live bag", () => {
    const bridge = new RenderBridge();
    const worker = FakeWorker.instances[0];
    bridge.setParams(tuned);
    bridge.setContributedParams({ "test.tuned.gain": 3 });
    expect(bagPosts(worker)[0]).toMatchObject({
      cmd: "setContributedParams",
      bag: { "test.tuned.gain": 3, "test.tuned#twice": 6 },
    });
    bridge.dispose();
  });

  it("re-posts the bag when the photo switches transform", () => {
    const bridge = new RenderBridge();
    const worker = FakeWorker.instances[0];
    bridge.setParams(tuned);
    bridge.setContributedParams({ "test.tuned.gain": 3 });
    bridge.setParams(normalizeParams({}));
    expect(bagPosts(worker).at(-1)).toEqual({ cmd: "patchContributedParams", set: {}, remove: ["test.tuned#twice"] });
    bridge.dispose();
  });

  it("captures with the derived uniforms of the capture's transform and bag", () => {
    const bridge = new RenderBridge();
    const worker = FakeWorker.instances[0];
    bridge.setParams(normalizeParams({}));
    bridge.setContributedParams({ "test.tuned.gain": 3 });
    void bridge.capture(tuned, { paramBag: { "test.tuned.gain": 5 } });
    void bridge.captureFloat(tuned);
    const patches = worker.posted.flatMap((m) =>
      m.cmd === "capture" || m.cmd === "captureFloat" ? [m.bagPatch] : [],
    );
    expect(patches).toEqual([
      { "test.tuned.gain": 5, "test.tuned#twice": 10 },
      { "test.tuned#twice": 6 },
    ]);
    bridge.dispose();
  });

  it("renders thumbnails with the derived uniforms of their transform and bag", () => {
    const bridge = new RenderBridge();
    const worker = FakeWorker.instances[0];
    bridge.setContributedParams({ "test.tuned.gain": 3 });
    void bridge.renderThumbnailFromSource({
      requestId: "t1",
      key: "k",
      params: tuned,
      asShotTemperature: 5000,
      maxEdge: 256,
      contributedParams: { "test.tuned.gain": 4 },
    });
    bridge.renderThumbnail({
      requestId: "t2",
      image: { kind: "float16", data: new Uint16Array(4), width: 1, height: 1 },
      params: tuned,
      asShotTemperature: 5000,
      maxEdge: 256,
    });
    const bags = worker.posted.flatMap((m) =>
      m.cmd === "renderThumbnailFromSource" || m.cmd === "renderThumbnail" ? [m.contributedParams] : [],
    );
    expect(bags).toEqual([
      { "test.tuned.gain": 4, "test.tuned#twice": 8 },
      { "test.tuned.gain": 3, "test.tuned#twice": 6 },
    ]);
    bridge.dispose();
  });

  it("renders a float thumbnail from a resident source with its transform's derived uniforms", () => {
    const bridge = new RenderBridge();
    const worker = FakeWorker.instances[0];
    bridge.setContributedParams({ "test.tuned.gain": 3 });
    void bridge.renderThumbnailFloat({
      requestId: "t4",
      key: "k",
      params: tuned,
      asShotTemperature: 5000,
      maxEdge: 256,
      float: { point: "pre-output" },
    });
    const sent = worker.posted.find((m) => m.cmd === "renderThumbnailFromSource");
    expect(sent && "contributedParams" in sent ? sent.contributedParams : undefined).toEqual({
      "test.tuned.gain": 3,
      "test.tuned#twice": 6,
    });
    bridge.dispose();
  });

  it("leaves a thumbnail of a plain transform without a bag of its own", () => {
    const bridge = new RenderBridge();
    const worker = FakeWorker.instances[0];
    bridge.setContributedParams({ "test.tuned.gain": 3 });
    bridge.renderThumbnail({
      requestId: "t3",
      image: { kind: "float16", data: new Uint16Array(4), width: 1, height: 1 },
      params: normalizeParams({}),
      asShotTemperature: 5000,
      maxEdge: 256,
    });
    const sent = worker.posted.find((m) => m.cmd === "renderThumbnail");
    expect(sent && "contributedParams" in sent ? sent.contributedParams : undefined).toBeUndefined();
    bridge.dispose();
  });
});

// The values the official and core stages derive from params go with the
// params they came from (stage-derive.ts): the live photo's with every params
// post, a capture's or a thumbnail's with its own request, so a draw of other
// params never reads the live photo's values.
describe("RenderBridge derived stage values", () => {
  const TONE: ProcessingStageContribution = {
    id: "safelight.basic.tone",
    name: "Tone",
    phase: "scene-linear",
    glsl: "lin *= exp2(uToneExposure);",
    uniforms: [{ key: "uToneExposure", glslType: "float", default: 0 }],
    derive: (p) => ({ uToneExposure: p.exposure }),
  };
  const KEY = "safelight.basic.tone.uToneExposure";

  beforeEach(() => {
    vi.useFakeTimers();
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
    registerProcessingStage("safelight.basic", TONE);
  });

  afterEach(() => {
    unregisterExtension("safelight.basic");
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const lastOf = <C extends WorkerRequest["cmd"]>(worker: FakeWorker, cmd: C) =>
    worker.posted.filter((m): m is Extract<WorkerRequest, { cmd: C }> => m.cmd === cmd).at(-1);

  it("sends the live photo's values with its params", () => {
    const bridge = new RenderBridge();
    const worker = FakeWorker.instances[0];
    bridge.setParams(normalizeParams({ exposure: 1.5 }));
    expect(lastOf(worker, "setParams")?.derived).toEqual({ [KEY]: 1.5 });
  });

  it("sends them with a patch when they change, and leaves them out when they don't", () => {
    const bridge = new RenderBridge();
    const worker = FakeWorker.instances[0];
    const base = normalizeParams({ exposure: 1 });
    bridge.setParams(base);
    bridge.setParams({ ...base, contrast: 20 });
    expect("derived" in (lastOf(worker, "patchParams") ?? {})).toBe(false);
    bridge.setParams({ ...base, exposure: 2 });
    expect(lastOf(worker, "patchParams")?.derived).toEqual({ [KEY]: 2 });
  });

  it("patches only the values that changed, and the keys dropped", () => {
    const CURVE: ProcessingStageContribution = {
      id: "safelight.tone-curve.curve",
      name: "Curve",
      phase: "display-adjust",
      glsl: "c *= uLift[0];",
      uniforms: [{ key: "uLift", glslType: "float", length: 1, default: [1] }],
      derive: (p) => ({ uLift: [1 + p.contrast / 100] }),
    };
    registerProcessingStage("safelight.tone-curve", CURVE);
    try {
      const bridge = new RenderBridge();
      const worker = FakeWorker.instances[0];
      const base = normalizeParams({ exposure: 1 });
      bridge.setParams(base);
      bridge.setParams({ ...base, contrast: 20 });
      expect(lastOf(worker, "patchParams")?.derived).toEqual({ "safelight.tone-curve.curve.uLift": [1.2] });
      unregisterExtension("safelight.tone-curve");
      bridge.setParams({ ...base, contrast: 20, exposure: 3 });
      expect(lastOf(worker, "patchParams")).toMatchObject({
        derived: { [KEY]: 3 },
        derivedRemove: ["safelight.tone-curve.curve.uLift"],
      });
    } finally {
      unregisterExtension("safelight.tone-curve");
    }
  });

  it("sends a capture's and a thumbnail's own values, not the live photo's", () => {
    const bridge = new RenderBridge();
    const worker = FakeWorker.instances[0];
    bridge.setParams(normalizeParams({ exposure: 1 }));
    void bridge.capture(normalizeParams({ exposure: -1 }));
    void bridge.captureFloat(normalizeParams({ exposure: -2 }));
    void bridge.renderThumbnailFromSource({
      requestId: "t",
      key: "k",
      params: normalizeParams({ exposure: 3 }),
      asShotTemperature: 6500,
      maxEdge: 64,
    });
    expect(lastOf(worker, "capture")?.derived).toEqual({ [KEY]: -1 });
    expect(lastOf(worker, "captureFloat")?.derived).toEqual({ [KEY]: -2 });
    expect(lastOf(worker, "renderThumbnailFromSource")?.derived).toEqual({ [KEY]: 3 });
  });

  it("sends the live photo's values again when a stage that derives them registers", () => {
    const bridge = new RenderBridge();
    const worker = FakeWorker.instances[0];
    unregisterExtension("safelight.basic");
    bridge.setParams(normalizeParams({ exposure: 1 }));
    expect(lastOf(worker, "setParams")?.derived).toEqual({});
    registerProcessingStage("safelight.basic", TONE);
    bridge.syncStages();
    expect(lastOf(worker, "setDerived")?.derived).toEqual({ [KEY]: 1 });
  });

  it("sends them again when the stage's extension changes a setting", () => {
    unregisterExtension("safelight.basic");
    registerProcessingStage("safelight.basic", {
      ...TONE,
      derive: (_, ctx) => ({ uToneExposure: ctx.settings("gain", 1) }),
    });
    const bridge = new RenderBridge();
    const worker = FakeWorker.instances[0];
    bridge.setParams(normalizeParams({}));
    setExtSetting("safelight.basic", "gain", 4);
    expect(lastOf(worker, "setDerived")?.derived).toEqual({ [KEY]: 4 });
  });
});

// A stage the worker's renderer couldn't build with is drawn without; the bridge
// keeps what it was told for the Extensions window, and its error names the
// extension rather than handing on the shader log alone.
describe("RenderBridge stage quarantine", () => {
  const BROKEN: ProcessingStageContribution = {
    id: "acme.film",
    name: "Film",
    phase: "effects",
    glsl: "c = c *;",
    uniforms: [],
  };
  const quarantined = (stage: ProcessingStageContribution): WorkerResponse => ({
    type: "stageQuarantined",
    stageId: stage.id,
    signature: stageSignature(stage),
    log: "Shader compile failed: ERROR: 0:823: ';' : syntax error\nERROR: 1 compilation errors.",
  });
  const failuresOfAcme = () =>
    stageFailuresOf("acme", useStageFailures.getState(), useRegistry.getState().processingStages);

  beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
    setExtensionName("acme", "Acme Film");
    registerProcessingStage("acme", BROKEN);
  });

  afterEach(() => {
    unregisterExtension("acme");
    useStageFailures.setState({}, true);
    vi.unstubAllGlobals();
  });

  it("records the stage against its extension and names the extension in the error", () => {
    const bridge = new RenderBridge();
    const errors: string[] = [];
    bridge.setOnError((message) => errors.push(message));
    FakeWorker.instances[0].reply(quarantined(BROKEN));

    expect(failuresOfAcme().map((f) => f.stageId)).toEqual(["acme.film"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Acme Film");
    expect(errors[0]).toContain("acme.film");
    expect(errors[0]).toContain("syntax error");
    expect(errors[0]).not.toContain("compilation errors");
    bridge.dispose();
  });

  it("forgets the failures when the worker's renderer is made again", () => {
    const bridge = new RenderBridge();
    bridge.setOnError(() => undefined);
    FakeWorker.instances[0].reply(quarantined(BROKEN));
    bridge.init(16, 16);

    expect(failuresOfAcme()).toEqual([]);
    bridge.dispose();
  });

  // The renderers try every quarantined stage again then, and report again
  // those that still fail.
  it("forgets the failures when the stage set loses a stage", () => {
    const other: ProcessingStageContribution = { ...BROKEN, id: "acme.grain", glsl: "c *= 0.9;" };
    registerProcessingStage("acme", other);
    const bridge = new RenderBridge();
    bridge.setOnError(() => undefined);
    bridge.syncStages();
    FakeWorker.instances[0].reply(quarantined(BROKEN));
    bridge.syncStages();
    expect(failuresOfAcme()).toHaveLength(1);

    unregisterProcessingStage("acme", other.id);
    bridge.syncStages();
    expect(failuresOfAcme()).toEqual([]);
    bridge.dispose();
  });

  it("lets the failure go once the stage is registered again changed", () => {
    const bridge = new RenderBridge();
    bridge.setOnError(() => undefined);
    FakeWorker.instances[0].reply(quarantined(BROKEN));
    registerProcessingStage("acme", { ...BROKEN, glsl: "c *= 0.5;" });

    expect(failuresOfAcme()).toEqual([]);
    bridge.dispose();
  });
});
