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
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { resetAllBindings, setBinding } from "@/state/keybindings-store";
import { viewportZoomCommands } from "@/state/viewport-zoom-commands";
import { snapshotCrossfade } from "./canvas-crossfade";
import { ViewportImage, assessMatPx } from "./ViewportImage";

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
  const fadeRef = useRef<HTMLCanvasElement>(null);
  return (
    <ViewportImage
      canvasRef={canvasRef}
      fadeCanvasRef={fadeRef}
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

// The Presets hover bumps fadeToken; the renderer fades its tiers on the same overlay,
// which the parent hands in.
describe("crossfade overlay and status", () => {
  let copies: { into: HTMLCanvasElement; image: unknown }[];
  let canvasContext: PropertyDescriptor | undefined;
  let handed: HTMLCanvasElement | null;

  function FadeHost({ token, status }: { token: number; status?: string | null }) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const fadeRef = useRef<HTMLCanvasElement>(null);
    useEffect(() => {
      handed = fadeRef.current;
    });
    return (
      <ViewportImage
        canvasRef={canvasRef}
        fadeCanvasRef={fadeRef}
        bufferWidth={1600}
        bufferHeight={1200}
        zoom={null}
        onZoomChange={() => {}}
        fadeToken={token}
        status={status}
      />
    );
  }

  beforeEach(() => {
    copies = [];
    handed = null;
    canvasContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: function getContext(this: HTMLCanvasElement) {
        const into = this;
        return { drawImage: (image: unknown) => copies.push({ into, image }) };
      },
    });
  });

  afterEach(() => {
    document.documentElement.classList.remove("sl-reduce-motion");
    if (canvasContext) {
      Object.defineProperty(HTMLCanvasElement.prototype, "getContext", canvasContext);
    }
  });

  it("fades the Presets hover on the overlay it is handed, over 220 ms", () => {
    const view = render(<FadeHost token={0} />);
    const [canvas, overlay] = view.container.querySelectorAll("canvas");
    expect(overlay).toBe(handed);

    view.rerender(<FadeHost token={1} />);

    expect(copies).toEqual([{ into: overlay, image: canvas }]);
    expect(overlay.style.transition).toBe("opacity 220ms ease-out");
    expect(overlay.style.opacity).toBe("0");
  });

  it("cuts the Presets hover under Reduce motion", () => {
    document.documentElement.classList.add("sl-reduce-motion");
    const view = render(<FadeHost token={0} />);
    view.rerender(<FadeHost token={1} />);
    expect(copies).toEqual([]);
  });

  it("shows the status it is given in the corner, and nothing without one", () => {
    const view = render(<FadeHost token={0} status="Preview" />);
    expect(view.getByText("Preview")).toBeTruthy();

    view.rerender(<FadeHost token={0} status={null} />);
    expect(view.queryByText("Preview")).toBeNull();
    expect(view.queryByText("Loading…")).toBeNull();
  });
});

// The fade overlay is laid out like the canvas. When the view jumps between the fit
// layout and the 100% one (which fills the frame with the window it renders), a
// picture fading out would show in a framing it never had: the whole image stretched
// over a crop. Such a jump cuts the fade.
describe("placement changes and the colour-assessment mat", () => {
  let canvasContext: PropertyDescriptor | undefined;
  let overlay: HTMLCanvasElement | null;
  let canvas: HTMLCanvasElement | null;

  interface PlacedProps {
    zoom: number | null;
    roi?: boolean;
    fadeInCommit?: boolean;
    buffer?: number;
    assess?: boolean;
    onLayout?: (
      visible: { x: number; y: number; w: number; h: number },
      image: { x: number; y: number; w: number; h: number },
      frame: { w: number; h: number },
    ) => void;
  }

  // `fadeInCommit` starts a fade from this parent's layout effect, which runs after
  // the viewport's own in the same commit, as the develop renderer's does.
  function Placed({ zoom, roi = true, fadeInCommit = false, buffer = 1600, assess, onLayout }: PlacedProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const fadeRef = useRef<HTMLCanvasElement>(null);
    useLayoutEffect(() => {
      overlay = fadeRef.current;
      canvas = canvasRef.current;
      if (fadeInCommit && canvas && overlay) snapshotCrossfade(canvas, overlay, 150);
    }, [fadeInCommit]);
    return (
      <ViewportImage
        canvasRef={canvasRef}
        fadeCanvasRef={fadeRef}
        bufferWidth={buffer}
        bufferHeight={buffer * 0.75}
        zoom={zoom}
        onZoomChange={() => {}}
        onViewport={roi ? () => {} : undefined}
        colorAssessment={assess}
        onLayout={onLayout}
      />
    );
  }

  beforeEach(() => {
    overlay = null;
    canvas = null;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    canvasContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: () => ({ drawImage: () => {} }),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    if (canvasContext) {
      Object.defineProperty(HTMLCanvasElement.prototype, "getContext", canvasContext);
    }
  });

  const fading = () => overlay?.style.transition === "opacity 150ms ease-out";

  function fadeNow() {
    if (!canvas || !overlay) throw new Error("not mounted");
    snapshotCrossfade(canvas, overlay, 150);
    expect(fading()).toBe(true);
  }

  it("cuts a fade when the view moves from fit to 100%", () => {
    const view = render(<Placed zoom={null} />);
    fadeNow();

    view.rerender(<Placed zoom={1} />);

    expect(fading()).toBe(false);
    expect(overlay?.style.opacity).toBe("0");
    expect(overlay?.width).toBe(0);
  });

  it("cuts a fade when the view moves from 100% back to fit", () => {
    const view = render(<Placed zoom={1} />);
    fadeNow();

    view.rerender(<Placed zoom={null} />);

    expect(fading()).toBe(false);
  });

  it("cuts a fade started later in the commit that moves the view", async () => {
    const view = render(<Placed zoom={null} />);

    await act(async () => {
      view.rerender(<Placed zoom={1} fadeInCommit />);
    });

    expect(fading()).toBe(false);
    expect(overlay?.width).toBe(0);
  });

  it("lets a fade run while the view keeps its layout", async () => {
    const view = render(<Placed zoom={null} roi={false} />);
    fadeNow();

    view.rerender(<Placed zoom={1} roi={false} />);
    expect(fading()).toBe(true);
    await act(async () => {
      view.rerender(<Placed zoom={1} roi={false} buffer={1200} fadeInCommit />);
    });

    expect(fading()).toBe(true);
  });

  it("reports the frame's size with the layout", () => {
    const onLayout = vi.fn();
    render(<Placed zoom={null} onLayout={onLayout} />);
    expect(onLayout).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      { w: FRAME.w, h: FRAME.h },
    );
  });

  // A canvas emptied for the next photo has no box to frame; the mat stayed at the
  // last photo's size around nothing.
  it("draws the mat only around a buffer that holds an image", () => {
    const view = render(<Placed zoom={null} assess />);
    const mat = () => view.container.querySelector<HTMLElement>("div[aria-hidden]");
    expect(mat()).not.toBeNull();

    view.rerender(<Placed zoom={null} assess buffer={0} />);
    expect(mat()).toBeNull();
  });

  it("draws the mat as wide as assessMatPx gives", () => {
    const view = render(<Placed zoom={null} assess />);
    const mat = view.container.querySelector<HTMLElement>("div[aria-hidden]");
    const border = assessMatPx(FRAME.w, FRAME.h, 0.045);
    expect(border).toBe(27);
    // Fit leaves room for the mat: 1600×1200 into 746×546 is a scale of 0.455, so
    // the image shows 728×546, 36 px in from the left.
    expect(mat?.style.left).toBe(`${36 - border}px`);
    expect(mat?.style.width).toBe(`${728 + 2 * border}px`);
  });
});
