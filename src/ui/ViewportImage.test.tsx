// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Wheel zoom on the shared image viewport. jsdom has no layout engine, so the
// frame geometry is stubbed to a fixed 800×600 with a 1600×1200 buffer — a fit
// scale of exactly 0.5 — where every expected number below is checkable by
// hand: one wheel notch is ×1.25, so the first zoom-in lands on 0.625, and a
// cursor at the frame centre (400,300) anchors the image point under it via
// offset = cursor − (cursor/0.5)·0.625 = (−100,−75). rAF is made synchronous
// so the handler's frame-coalescing applies within the dispatching act().

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { useRef, useState } from "react";
import { resetAllBindings, setBinding } from "@/state/keybindings-store";
import { viewportZoomCommands } from "@/state/viewport-zoom-commands";
import { ViewportImage } from "./ViewportImage";

const FRAME = { w: 800, h: 600 };

class FixedFrameObserver {
  private readonly cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(): void {
    this.cb(
      [{ contentRect: { width: FRAME.w, height: FRAME.h } }] as never,
      this as never,
    );
  }
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", FixedFrameObserver);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: FRAME.w,
      bottom: FRAME.h,
      width: FRAME.w,
      height: FRAME.h,
      toJSON: () => ({}),
    }),
  });
});

const zoomSpy = vi.fn<(zoom: number | null) => void>();

function Host({ start = null, locked = false }: { start?: number | null; locked?: boolean }) {
  const [zoom, setZoom] = useState<number | null>(start);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  return (
    <ViewportImage
      canvasRef={canvasRef}
      bufferWidth={1600}
      bufferHeight={1200}
      zoom={zoom}
      onZoomChange={(z) => {
        zoomSpy(z);
        setZoom(z);
      }}
      initialZoom={start}
      overlay={locked ? () => <div /> : undefined}
    />
  );
}

function mount(props: { start?: number | null; locked?: boolean } = {}) {
  const utils = render(<Host {...props} />);
  zoomSpy.mockClear();
  const frame = utils.container.firstElementChild as HTMLElement;
  return { frame, ...utils };
}

function roll(
  frame: HTMLElement,
  deltaY: number,
  mods: { alt?: boolean; ctrl?: boolean } = {},
  at = { x: 400, y: 300 },
): WheelEvent {
  const e = new WheelEvent("wheel", {
    deltaY,
    clientX: at.x,
    clientY: at.y,
    altKey: !!mods.alt,
    ctrlKey: !!mods.ctrl,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    frame.dispatchEvent(e);
  });
  return e;
}

beforeEach(() => zoomSpy.mockClear());
afterEach(() => resetAllBindings());

describe("wheel zoom", () => {
  it("zooms in from fit, anchored at the cursor", () => {
    const { frame } = mount();
    roll(frame, -100);
    expect(zoomSpy).toHaveBeenLastCalledWith(0.625);
    const canvas = frame.querySelector("canvas")!;
    expect(canvas.style.transform).toBe("translate(-100px, -75px) scale(0.625)");
  });

  it("consumes a handled wheel so the page cannot scroll or zoom", () => {
    const { frame } = mount();
    expect(roll(frame, -100).defaultPrevented).toBe(true);
  });

  it("snaps back to fit when zooming out reaches the fit scale", () => {
    const { frame } = mount({ start: 0.625 });
    roll(frame, 100);
    expect(zoomSpy).toHaveBeenLastCalledWith(null);
  });

  it("does nothing from fit when zooming out, but still owns the event", () => {
    const { frame } = mount();
    const e = roll(frame, 100);
    expect(zoomSpy).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });

  it("clamps at 200%", () => {
    const { frame } = mount({ start: 1.8 });
    roll(frame, -100);
    expect(zoomSpy).toHaveBeenLastCalledWith(2);
    zoomSpy.mockClear();
    roll(frame, -100);
    expect(zoomSpy).not.toHaveBeenCalled();
  });

  it("goes inert on bare wheel once rebound to Alt+Wheel", () => {
    setBinding("viewport.wheelZoom", "Alt+Wheel");
    const { frame } = mount();
    const e = roll(frame, -100);
    expect(zoomSpy).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
    roll(frame, -100, { alt: true });
    expect(zoomSpy).toHaveBeenLastCalledWith(0.625);
  });

  it("always zooms on Ctrl/⌘+wheel (the trackpad pinch encoding)", () => {
    setBinding("viewport.wheelZoom", "Alt+Wheel");
    const { frame } = mount();
    const e = roll(frame, -100, { ctrl: true });
    expect(zoomSpy).toHaveBeenLastCalledWith(0.625);
    expect(e.defaultPrevented).toBe(true);
  });

  it("ignores the wheel while the view is crop-locked", () => {
    const { frame } = mount({ locked: true });
    const e = roll(frame, -100);
    expect(zoomSpy).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });
});

describe("keyboard zoom commands", () => {
  it("registers commands while mounted and clears on unmount", () => {
    const { unmount } = mount();
    expect(viewportZoomCommands()).not.toBeNull();
    unmount();
    expect(viewportZoomCommands()).toBeNull();
  });

  it("does not register while crop-locked", () => {
    mount({ locked: true });
    expect(viewportZoomCommands()).toBeNull();
  });

  it("zoomStep steps by 1.25×, anchored at the frame centre without a cursor", () => {
    const { frame } = mount();
    act(() => viewportZoomCommands()!.zoomStep(1));
    expect(zoomSpy).toHaveBeenLastCalledWith(0.625);
    const canvas = frame.querySelector("canvas")!;
    expect(canvas.style.transform).toBe("translate(-100px, -75px) scale(0.625)");
    act(() => viewportZoomCommands()!.zoomStep(-1));
    expect(zoomSpy).toHaveBeenLastCalledWith(null);
  });

  it("zoom100 jumps to 100% and zoomFit returns to fit", () => {
    mount();
    act(() => viewportZoomCommands()!.zoom100());
    expect(zoomSpy).toHaveBeenLastCalledWith(1);
    act(() => viewportZoomCommands()!.zoomFit());
    expect(zoomSpy).toHaveBeenLastCalledWith(null);
  });
});
