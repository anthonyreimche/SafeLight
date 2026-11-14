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
import { useState } from "react";
import type { CatalogPhoto } from "@/catalog/types";
import { DEFAULT_DEVELOP_PARAMS } from "@/catalog/types";
import { useDevelopOverlay } from "@/extensions/develop-host";
import { CALLBACK_FAILURE_LIMIT, forgetCallbackFailures, useCallbackFailures } from "@/extensions/guard";
import { registerProcessingStage, registerSlot, unregisterExtension } from "@/extensions/registry";
import type { RenderBridge } from "@/rendering/render-bridge";
import { essentialStages } from "@/rendering/webgl/essential-stages.fixtures";
import { useDevelopStore } from "@/state/develop-store";
import { useSettings } from "@/state/settings-store";
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

// A held canvas tool has the canvas: an extension's overlay may not cover the
// tool's own (a crop box under another extension's picture of the photo), nor
// take the pointer from it.
describe("DevelopCanvas's canvas tool among canvas-overlay extensions", () => {
  const ExtOverlay = () => <div data-testid="ext-overlay" />;
  const ToolOverlay = () => <div data-testid="tool-overlay" />;

  /** The z-index `el` stacks at among the canvas's layers: that of its
   *  outermost ancestor carrying one, 0 without. */
  const stackLevel = (el: HTMLElement, root: HTMLElement): number => {
    let level = 0;
    for (let p: HTMLElement | null = el; p && p !== root; p = p.parentElement) {
      if (p.style.zIndex !== "") level = Number(p.style.zIndex);
    }
    return level;
  };

  beforeEach(() => {
    registerSlot("acme.overlay", { id: "acme.overlay.cover", slot: "develop-canvas-overlay", component: ExtOverlay });
  });

  it.each([
    ["that locks the view (crop mode)", false],
    ["that leaves zoom and pan (a brush)", true],
  ])("stacks the overlay of a tool %s above the canvas-overlay extensions", (_label, zoomable) => {
    const { container } = render(<DevelopCanvas photo={PHOTO} zoom={null} onZoomChange={() => {}} />);
    act(() => setCanvasTool("acme.tool", { overlay: ToolOverlay, zoomable }));
    const tool = screen.getByTestId("tool-overlay");
    const ext = screen.getByTestId("ext-overlay");
    expect(stackLevel(tool, container)).toBeGreaterThan(stackLevel(ext, container));
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

// Dynamic mode measures the zoom in the photo's own pixels: the source the
// buffer is drawn from is a capped copy, `fullWidth` the decoded photo's width.
// The canvas buffer here is 1000 px wide, so at zoom 1 its scale on screen is the
// number of photo pixels each of its pixels stands for.
describe("DevelopCanvas's zoom in Dynamic mode", () => {
  const SOURCE = { width: 3072, height: 2048, fullWidth: 6000, fullHeight: 4000, native: true };
  const NO_SIZE = { width: 0, height: 0, fullWidth: 0, fullHeight: 0, native: false };
  const settingsBefore = useSettings.getState();

  function Host() {
    const [zoom, setZoom] = useState<number | null>(null);
    return <DevelopCanvas photo={PHOTO} zoom={zoom} onZoomChange={setZoom} />;
  }

  const shownScale = () => {
    const m = /scale\(([^,)]+)\)/.exec(document.querySelector("canvas")?.style.transform ?? "");
    if (!m) throw new Error("canvas not placed");
    return Number(m[1]);
  };

  afterEach(() => {
    useSettings.setState({
      developDynamicDetail: settingsBefore.developDynamicDetail,
      developOpenZoom: settingsBefore.developOpenZoom,
    });
    useDevelopStore.setState({ sourceSize: NO_SIZE });
  });

  it.each([
    ["off, whatever the sizes", false, SOURCE, 1],
    ["on, the photo larger than its source", true, SOURCE, 6000 / 3072],
    ["on, the source the photo's own size", true, { ...SOURCE, fullWidth: 3072, fullHeight: 2048 }, 1],
  ])("scales zoom 1 by the photo's pixels with Dynamic %s", (_label, dynamic, size, factor) => {
    useSettings.setState({ developDynamicDetail: dynamic });
    useDevelopStore.setState({ sourceSize: size });
    render(<DevelopCanvas photo={PHOTO} zoom={1} onZoomChange={() => {}} />);
    expect(shownScale()).toBeCloseTo(factor, 12);
  });

  // Only a photo native detail can reach is measured in its own pixels: anything
  // else would show 100% as an upscale of the source.
  it.each([
    ["a JPEG whose file is larger than its source", { ...PHOTO, filename: "p.jpg", relPath: "p.jpg" }, SOURCE],
    ["a RAW shown from its camera preview", PHOTO, { ...SOURCE, native: false }],
  ])("keeps the source's scale for %s", (_label, shown, size) => {
    useSettings.setState({ developDynamicDetail: true });
    useDevelopStore.setState({ sourceSize: size });
    render(<DevelopCanvas photo={shown} zoom={1} onZoomChange={() => {}} />);
    expect(shownScale()).toBe(1);
  });

  it("measures a RAW from its own decode in its own pixels", () => {
    useSettings.setState({ developDynamicDetail: true });
    useDevelopStore.setState({ sourceSize: SOURCE });
    render(<DevelopCanvas photo={PHOTO} zoom={1} onZoomChange={() => {}} />);
    expect(shownScale()).toBeCloseTo(6000 / 3072, 12);
  });

  // 100% is one pixel per device pixel, as in other editors: on a screen scaled
  // 2x that is half a CSS pixel, of the photo in Dynamic mode and of the buffer
  // otherwise.
  it.each([
    ["the photo's pixels in Dynamic mode", true, 6000 / 3072 / 2],
    ["the buffer's pixels at a fixed size", false, 1 / 2],
  ])("measures %s against device pixels on a scaled screen", (_label, dynamic, factor) => {
    const before = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
    Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true });
    try {
      useSettings.setState({ developDynamicDetail: dynamic });
      useDevelopStore.setState({ sourceSize: SOURCE });
      render(<DevelopCanvas photo={PHOTO} zoom={1} onZoomChange={() => {}} />);
      expect(shownScale()).toBeCloseTo(factor, 12);
    } finally {
      if (before) Object.defineProperty(window, "devicePixelRatio", before);
      else Reflect.deleteProperty(window, "devicePixelRatio");
    }
  });

  it("opens a photo at one photo pixel per CSS px when set to open at 100%", () => {
    useSettings.setState({ developDynamicDetail: true, developOpenZoom: "100" });
    useDevelopStore.setState({ sourceSize: SOURCE });
    render(<Host />);
    expect(shownScale()).toBeCloseTo(6000 / 3072, 12);
  });

  it("still does when the photo's full size comes after its first picture", () => {
    useSettings.setState({ developDynamicDetail: true, developOpenZoom: "100" });
    render(<Host />);
    expect(shownScale()).toBe(1);
    act(() => useDevelopStore.setState({ sourceSize: SOURCE }));
    expect(shownScale()).toBeCloseTo(6000 / 3072, 12);
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
