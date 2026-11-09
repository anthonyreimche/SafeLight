// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What an extension draws over the Develop canvas: an overlay in the
// develop-canvas-overlay slot draws again only when what it reads changes, not
// on every slider tick, and a canvas tool's overlay that throws is contained
// to its own notice. The renderer is a stand-in that re-renders the canvas on
// every params change, as a parent drawing it again for its own reasons does.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CatalogPhoto } from "@/catalog/types";
import { DEFAULT_DEVELOP_PARAMS } from "@/catalog/types";
import { useDevelopOverlay } from "@/extensions/develop-host";
import { CALLBACK_FAILURE_LIMIT, forgetCallbackFailures, useCallbackFailures } from "@/extensions/guard";
import { registerProcessingStage, registerSlot, unregisterExtension } from "@/extensions/registry";
import type { RenderBridge } from "@/rendering/render-bridge";
import { essentialStages } from "@/rendering/webgl/essential-stages.fixtures";
import { useDevelopStore } from "@/state/develop-store";
import { useDevicePixelRatio } from "@/ui/use-device-pixel-ratio";
import { setCanvasTool, useCanvasToolStore } from "./canvas-tool";
import { DevelopCanvas } from "./DevelopCanvas";
import { setPickDrag } from "./pick-drag";

vi.mock("libraw-wasm", () => ({ default: class {} }));

const probe = vi.hoisted(() => vi.fn<RenderBridge["probe"]>());
vi.mock("@/rendering/render-bridge", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/rendering/render-bridge")>();
  return { ...real, getRenderBridge: () => ({ probe }) };
});

// The viewport reads the pixel ratio once a render, and nothing else on the canvas
// does: its calls count the viewport's renders.
vi.mock("@/ui/use-device-pixel-ratio", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/ui/use-device-pixel-ratio")>();
  return { ...real, useDevicePixelRatio: vi.fn(real.useDevicePixelRatio) };
});

vi.mock("@/hooks/use-develop-renderer", async () => {
  const { useDevelopStore: store } = await import("@/state/develop-store");
  // The same functions on every render, as the real renderer's are.
  const setViewport = () => {};
  const pictureCanvas = () => null;
  return {
    useDevelopRenderer: () => {
      store((s) => s.params);
      return {
        supported: true,
        availability: "ready",
        availabilityReason: null,
        status: null,
        overflowedStages: [],
        width: 1000,
        height: 750,
        bufferWindow: null,
        wholeWidth: 1000,
        wholeHeight: 750,
        bufferCrop: null,
        sourceWidth: 4000,
        sourceHeight: 3000,
        tier: "full",
        setViewport,
        pictureCanvas,
      };
    },
  };
});

const CROP_STAGE = essentialStages().find((s) => s.id === "safelight.crop.geometry")!;

const PHOTO = {
  id: "p",
  filename: "p.orf",
  relPath: "p.orf",
  folder: "",
  width: 4000,
  height: 3000,
  keywords: [],
  exif: {},
} as unknown as CatalogPhoto;

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

let overlayRenders = 0;
function CountingOverlay() {
  useDevelopOverlay();
  overlayRenders++;
  return null;
}

const drag = () => {
  for (let i = 1; i <= 100; i++) act(() => useDevelopStore.getState().setParam("exposure", i / 100));
};

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FixedFrameObserver);
  useDevelopStore.setState({ photoId: PHOTO.id, params: DEFAULT_DEVELOP_PARAMS, paramBag: {} });
  overlayRenders = 0;
});

afterEach(() => {
  cleanup();
  useCanvasToolStore.setState({ held: null });
  unregisterExtension("acme.overlay");
  unregisterExtension("safelight.crop");
  vi.unstubAllGlobals();
});

describe("DevelopCanvas overlays", () => {
  it.each([
    ["without a geometry stage", false],
    ["with Crop & Straighten's geometry stage", true],
  ])("doesn't draw a canvas-overlay extension again on an Exposure drag, %s", (_label, geometry) => {
    if (geometry) registerProcessingStage("safelight.crop", CROP_STAGE);
    registerSlot("acme.overlay", { id: "acme.overlay.count", slot: "develop-canvas-overlay", component: CountingOverlay });
    render(<DevelopCanvas photo={PHOTO} zoom={null} onZoomChange={() => {}} />);
    const before = overlayRenders;
    expect(before).toBeGreaterThan(0);
    drag();
    expect(overlayRenders - before).toBe(0);
  });

  it("draws it again when the crop it maps through changes", () => {
    registerProcessingStage("safelight.crop", CROP_STAGE);
    registerSlot("acme.overlay", { id: "acme.overlay.count", slot: "develop-canvas-overlay", component: CountingOverlay });
    render(<DevelopCanvas photo={PHOTO} zoom={null} onZoomChange={() => {}} />);
    const before = overlayRenders;
    act(() => useDevelopStore.getState().setParam("crop", { x: 0.1, y: 0.1, width: 0.5, height: 0.5 }));
    expect(overlayRenders).toBeGreaterThan(before);
  });

  it("contains a canvas tool's overlay that throws to its own notice", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const Broken = (): null => {
      throw new Error("tool overlay blew up");
    };
    render(<DevelopCanvas photo={PHOTO} zoom={null} onZoomChange={() => {}} />);
    act(() => setCanvasTool("acme.tool", { overlay: Broken }));
    expect(screen.getByText('Canvas tool "acme.tool" crashed: tool overlay blew up')).toBeTruthy();
    error.mockRestore();
  });
});

// The viewport draws again only when what it is handed changes, not each time the
// canvas around it does.
describe("DevelopCanvas's viewport", () => {
  const viewportRenders = () => vi.mocked(useDevicePixelRatio).mock.calls.length;

  afterEach(() => {
    setPickDrag("acme.pick", null);
  });

  it("doesn't draw a canvas tool's overlay again on an Exposure drag", () => {
    let toolRenders = 0;
    const Tool = (): null => {
      toolRenders++;
      return null;
    };
    render(<DevelopCanvas photo={PHOTO} zoom={null} onZoomChange={() => {}} />);
    act(() => setCanvasTool("acme.tool", { overlay: Tool, zoomable: true }));
    const before = toolRenders;
    expect(before).toBeGreaterThan(0);
    drag();
    expect(toolRenders - before).toBe(0);
  });

  it("isn't drawn again on an Exposure drag while a pick-drag tool is held", () => {
    render(<DevelopCanvas photo={PHOTO} zoom={null} onZoomChange={() => {}} />);
    act(() => setPickDrag("acme.pick", { onPress: () => {} }));
    const before = viewportRenders();
    expect(before).toBeGreaterThan(0);
    drag();
    expect(viewportRenders() - before).toBe(0);
  });
});

// An extension's pick-drag tool is called where nothing else would catch it, as a
// canvas tool is: a throw is contained to its own call, and a tool that keeps
// throwing is switched off and listed.
describe("DevelopCanvas's pick-drag tool", () => {
  const GREEN: [number, number, number] = [0.1, 0.7, 0.1];
  const frame = () => {
    const parent = document.querySelector("canvas")?.parentElement;
    if (!parent) throw new Error("no viewport frame");
    return parent;
  };
  const press = async () => {
    await act(async () => {
      fireEvent.pointerDown(frame(), { pointerId: 1, button: 0, clientX: 500, clientY: 400 });
    });
    await act(async () => {
      fireEvent.pointerUp(frame(), { pointerId: 1, button: 0, clientX: 500, clientY: 400 });
    });
  };

  beforeEach(() => {
    probe.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    setPickDrag("ext.x", null);
    forgetCallbackFailures("ext.x");
    vi.restoreAllMocks();
  });

  it("still probes and hands on the colour when the tool's press throws, and switches that off", async () => {
    probe.mockResolvedValue(GREEN);
    const onDown = vi.fn();
    render(<DevelopCanvas photo={PHOTO} zoom={null} onZoomChange={() => {}} />);
    act(() =>
      setPickDrag("ext.x", {
        onPress: () => {
          throw new Error("press blew up");
        },
        onDown,
      }),
    );

    await press();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(onDown).toHaveBeenCalledWith(GREEN, expect.anything());

    for (let i = 1; i < CALLBACK_FAILURE_LIMIT; i++) await press();
    expect(useCallbackFailures.getState()["ext.x"]).toMatchObject({ kind: "pick-drag press" });
  });

  it("hands on nothing when the probe fails", async () => {
    probe.mockRejectedValue(new Error("worker gone"));
    const onDown = vi.fn();
    render(<DevelopCanvas photo={PHOTO} zoom={null} onZoomChange={() => {}} />);
    act(() => setPickDrag("ext.x", { onDown }));

    await press();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(onDown).not.toHaveBeenCalled();
  });
});
