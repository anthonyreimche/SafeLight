// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What an extension draws over the Develop canvas: an overlay in the
// develop-canvas-overlay slot draws again only when what it reads changes, not
// on every slider tick, and a canvas tool's overlay that throws is contained
// to its own notice. The renderer is a stand-in that, like the real one,
// re-renders the canvas on every params change.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { CatalogPhoto } from "@/catalog/types";
import { DEFAULT_DEVELOP_PARAMS } from "@/catalog/types";
import { useDevelopOverlay } from "@/extensions/develop-host";
import { registerProcessingStage, registerSlot, unregisterExtension } from "@/extensions/registry";
import { essentialStages } from "@/rendering/webgl/essential-stages.fixtures";
import { useDevelopStore } from "@/state/develop-store";
import { setCanvasTool, useCanvasToolStore } from "./canvas-tool";
import { DevelopCanvas } from "./DevelopCanvas";

vi.mock("libraw-wasm", () => ({ default: class {} }));

vi.mock("@/hooks/use-develop-renderer", async () => {
  const { useDevelopStore: store } = await import("@/state/develop-store");
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
        setViewport: () => {},
        pictureCanvas: () => null,
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
