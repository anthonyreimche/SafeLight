import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  getRenderBridge: vi.fn(),
  readGpuBackend: vi.fn(async () => undefined),
}));

vi.mock("./render-bridge", () => ({ getRenderBridge: h.getRenderBridge }));
vi.mock("@/project/project-store", async () => {
  const { create } = await import("zustand");
  return { useProjectStore: create<{ root: object | null }>(() => ({ root: null })) };
});
vi.mock("@/extensions/loader", async () => {
  const { create } = await import("zustand");
  return { useExternalPluginsSettled: create<{ settled: boolean }>(() => ({ settled: false })) };
});
vi.mock("@/state/graphics-store", async () => {
  const { create } = await import("zustand");
  return {
    readGpuBackend: h.readGpuBackend,
    useGraphics: create<{ software: boolean | null; webgl2: string }>(() => ({
      software: false,
      webgl2: "yes",
    })),
  };
});

import { useProjectStore } from "@/project/project-store";
import { useExternalPluginsSettled } from "@/extensions/loader";
import { useGraphics } from "@/state/graphics-store";
import { startRenderBridgeWarmup } from "./render-bridge-warm";

describe("render bridge warm-up", () => {
  let idle: (() => void)[];
  let stop: () => void;
  const runIdle = async () => {
    const due = idle;
    idle = [];
    for (const run of due) run();
    await vi.advanceTimersByTimeAsync(0);
  };
  const folder = () => ({ kind: "directory", name: "p" }) as FileSystemDirectoryHandle;
  const open = () => useProjectStore.setState({ root: folder() });
  const settle = () => useExternalPluginsSettled.setState({ settled: true });

  beforeEach(() => {
    vi.useFakeTimers();
    idle = [];
    vi.stubGlobal("requestIdleCallback", (run: () => void) => idle.push(run));
    vi.stubGlobal("cancelIdleCallback", () => undefined);
    h.getRenderBridge.mockClear();
    h.readGpuBackend.mockClear();
    useProjectStore.setState({ root: null });
    useExternalPluginsSettled.setState({ settled: false });
    useGraphics.setState({ software: false, webgl2: "yes" });
    stop = startRenderBridgeWarmup();
  });

  afterEach(() => {
    stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not start the bridge before a project is open and the extensions settled", async () => {
    await runIdle();
    expect(h.getRenderBridge).not.toHaveBeenCalled();
    open();
    await runIdle();
    expect(h.getRenderBridge).not.toHaveBeenCalled();
  });

  it("does not start it in the same turn it becomes ready, only in an idle callback", async () => {
    open();
    settle();
    expect(h.getRenderBridge).not.toHaveBeenCalled();
    await runIdle();
    expect(h.getRenderBridge).toHaveBeenCalledTimes(1);
  });

  it("starts it once however often the stores change", async () => {
    settle();
    open();
    await runIdle();
    open();
    useExternalPluginsSettled.setState({ settled: true });
    await runIdle();
    expect(h.getRenderBridge).toHaveBeenCalledTimes(1);
  });

  it("never starts it when the graphics backend is software rendering", async () => {
    useGraphics.setState({ software: true });
    open();
    settle();
    await runIdle();
    expect(h.getRenderBridge).not.toHaveBeenCalled();
  });

  it("reads the backend first when it isn't known yet, then honours it", async () => {
    useGraphics.setState({ software: null });
    h.readGpuBackend.mockImplementationOnce(async () => {
      useGraphics.setState({ software: true });
    });
    open();
    settle();
    await runIdle();
    expect(h.readGpuBackend).toHaveBeenCalledTimes(1);
    expect(h.getRenderBridge).not.toHaveBeenCalled();
  });

  it("starts nothing after it is stopped", async () => {
    open();
    settle();
    stop();
    await runIdle();
    expect(h.getRenderBridge).not.toHaveBeenCalled();
  });
});
