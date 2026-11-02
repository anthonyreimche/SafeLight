// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Smoke: the render worker is lost with Develop open. The real Develop canvas,
// renderer hook and bridge run over a stand-in worker; jsdom has no GPU, so
// canvases hand out a context that only records nothing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import type { CatalogPhoto } from "@/catalog/types";
import { DEFAULT_DEVELOP_PARAMS } from "@/catalog/types";
import { disposeRenderBridge, getRenderBridge, type RenderBridge } from "./render-bridge";
import type { WorkerRequest, WorkerResponse } from "./render-protocol";
import { DevelopCanvas } from "@/modules/develop/DevelopCanvas";
import { useDevelopStore } from "@/state/develop-store";
import { useGraphics } from "@/state/graphics-store";

vi.mock("libraw-wasm", () => ({ default: class {} }));

class FakeWorker {
  static instances: FakeWorker[] = [];
  posted: WorkerRequest[] = [];
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(msg: WorkerRequest): void {
    this.posted.push(msg);
  }

  terminate(): void {}

  reply(msg: WorkerResponse): void {
    this.onmessage?.({ data: msg } as MessageEvent<WorkerResponse>);
  }
}

class FixedFrameObserver {
  private readonly cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(): void {
    this.cb([{ contentRect: { width: 1000, height: 800 } }] as never, this as never);
  }
  unobserve(): void {}
  disconnect(): void {}
}

const PHOTO = {
  id: "p",
  filename: "p.jpg",
  relPath: "p.jpg",
  folder: "",
  directoryHandle: null,
  fileHandle: null,
  thumbnailBlob: null,
  thumbnailUrl: null,
  width: 4000,
  height: 3000,
  keywords: [],
  exif: {},
} as unknown as CatalogPhoto;

const renderWorker = (): FakeWorker => {
  const worker = FakeWorker.instances.find((w) => w.posted.some((m) => m.cmd === "init"));
  if (!worker) throw new Error("no render worker");
  return worker;
};

const says = (text: string) => document.body.textContent?.includes(text) ?? false;

/** A request of each kind a caller can be waiting on, and what each settled
 *  with. `long` adds a read of the developed frame: one long job, which the
 *  bridge doesn't time while it runs. */
function askEverything(bridge: RenderBridge, long = true) {
  const asked = {
    bound: bridge.bindSource("k"),
    has: bridge.hasSource("main", "k"),
    probe: bridge.probe(0.5, 0.5, "output"),
    sample: bridge.readSourceSample(),
    ...(long ? { pixels: bridge.readDevelopedPixels(256) } : {}),
    thumb: bridge.renderThumbnailFromSource({
      requestId: "t",
      key: "k",
      params: DEFAULT_DEVELOP_PARAMS,
      asShotTemperature: 5000,
      maxEdge: 256,
    }),
  };
  const settled: Record<string, unknown> = {};
  for (const [name, promise] of Object.entries(asked))
    void promise.then((value: unknown) => (settled[name] = value));
  return settled;
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

let canvasContext: PropertyDescriptor | undefined;

beforeEach(() => {
  FakeWorker.instances = [];
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("ResizeObserver", FixedFrameObserver);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  canvasContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => ({ drawImage() {}, clearRect() {}, getExtension: () => null }),
  });
  useGraphics.setState({ webgl2: "unknown", reason: null });
  useDevelopStore.setState({ photoId: PHOTO.id, params: DEFAULT_DEVELOP_PARAMS, paramBag: {} });
});

afterEach(() => {
  disposeRenderBridge();
  if (canvasContext) Object.defineProperty(HTMLCanvasElement.prototype, "getContext", canvasContext);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("smoke: losing the render worker", () => {
  it("fails over while it starts: ready and every request settle, and Develop says so", async () => {
    render(<DevelopCanvas photo={PHOTO} zoom={null} onZoomChange={() => {}} />);
    const bridge = getRenderBridge();
    let ready = false;
    void bridge.ready.then(() => (ready = true));
    const settled = askEverything(bridge);

    act(() => renderWorker().onerror?.(new ErrorEvent("error", { message: "Render worker crashed" })));
    await flush();

    expect(bridge.availability).toBe("failed");
    expect(ready).toBe(true);
    expect(settled).toEqual({ bound: false, has: false, probe: null, sample: null, pixels: null, thumb: null });
    expect(says("Can't show images right now. Restart Safelight.")).toBe(true);
    expect(says("Reason: Render worker crashed")).toBe(true);
    const posted = renderWorker().posted.length;
    bridge.render();
    expect(renderWorker().posted).toHaveLength(posted);
  });

  it("settles the requests a worker that falls silent once started never answers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    render(<DevelopCanvas photo={PHOTO} zoom={null} onZoomChange={() => {}} />);
    const bridge = getRenderBridge();
    act(() => renderWorker().reply({ type: "ready", pipelineFloat: true }));
    const settled = askEverything(bridge, false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(settled).toEqual({ bound: false, has: false, probe: null, sample: null, thumb: null });
  });

  it("says so once a started worker has said nothing for a minute with renders waiting, and stops once it speaks", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    render(<DevelopCanvas photo={PHOTO} zoom={null} onZoomChange={() => {}} />);
    const bridge = getRenderBridge();
    act(() => renderWorker().reply({ type: "ready", pipelineFloat: true }));

    await act(async () => {
      for (let t = 0; t < 60_000; t += 1_000) {
        bridge.render();
        await vi.advanceTimersByTimeAsync(1_000);
      }
    });

    expect(bridge.availability).toBe("unresponsive");
    expect(says("The graphics engine isn't responding. Waiting for it…")).toBe(true);
    expect(says("Trying again")).toBe(false);
    expect(says("Reason: the renderer stopped responding")).toBe(true);

    const [first] = renderWorker().posted.filter(
      (m): m is Extract<WorkerRequest, { cmd: "render" }> => m.cmd === "render",
    );
    act(() => renderWorker().reply({ type: "frameSkipped", seq: first.seq }));
    expect(bridge.availability).toBe("ready");
    expect(says("The graphics engine isn't responding")).toBe(false);
  });

  it("says so while the worker's graphics context is lost, and hands the photo over again once it is restored", async () => {
    render(<DevelopCanvas photo={PHOTO} zoom={null} onZoomChange={() => {}} />);
    act(() => renderWorker().reply({ type: "ready", pipelineFloat: true }));
    await flush();
    const handovers = () =>
      renderWorker().posted.filter(
        (m) => m.cmd === "bindSource" || m.cmd === "setImage" || (m.cmd === "uploadSource" && m.target === "main"),
      ).length;
    const before = handovers();
    expect(before).toBeGreaterThan(0);

    act(() => renderWorker().reply({ type: "contextLost" }));
    expect(says("The graphics engine was reset. Waiting for it…")).toBe(true);
    expect(says("Trying again")).toBe(false);
    expect(says("Reason: the graphics context was lost")).toBe(true);

    act(() => renderWorker().reply({ type: "ready", pipelineFloat: true }));
    await flush();
    expect(says("The graphics engine was reset")).toBe(false);
    expect(handovers()).toBe(before + 1);
  });
});
