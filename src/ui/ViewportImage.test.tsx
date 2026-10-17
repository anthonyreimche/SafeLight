// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Wheel zoom on the shared image viewport. jsdom has no layout engine, so the
// frame geometry is stubbed to a fixed 800×600 with a 1600×1200 buffer — a fit
// scale of exactly 0.5 — where every expected number below is checkable by
// hand: one wheel notch is ×1.25, so the first zoom-in lands on 0.625, and a
// cursor at the frame centre (400,300) anchors the image point under it via
// offset = cursor − (cursor/0.5)·0.625 = (−100,−75). Animation frames and the
// clock are faked: frames come every 16 ms of advance().

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { resetAllBindings, setBinding } from "@/state/keybindings-store";
import { viewportZoomCommands } from "@/state/viewport-zoom-commands";
import { snapshotCrossfade } from "./canvas-crossfade";
import { ViewportImage, assessMatPx } from "./ViewportImage";
import type { ImageWindow } from "./viewport-view";

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

const FRAME_MS = 16;

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"],
  });
});

afterEach(() => {
  vi.useRealTimers();
  document.documentElement.classList.remove("sl-reduce-motion");
});

/** Runs `ms` of animation frames, each in its own act() so the renders and effects
 *  one frame causes are done before the next. */
function advance(ms: number) {
  for (let t = 0; t < ms; t += FRAME_MS) {
    act(() => {
      vi.advanceTimersByTime(FRAME_MS);
    });
  }
}

const zoomSpy = vi.fn<(zoom: number | null) => void>();

function Host({
  start = null,
  locked = false,
  resetKey,
}: {
  start?: number | null;
  locked?: boolean;
  resetKey?: string;
}) {
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
      resetKey={resetKey}
      initialZoom={start}
      overlay={locked ? () => <div /> : undefined}
    />
  );
}

/** A viewport whose zoom the parent sets, as the status bar's buttons do. */
function Controlled({ zoom }: { zoom: number | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fadeRef = useRef<HTMLCanvasElement>(null);
  return (
    <ViewportImage
      canvasRef={canvasRef}
      fadeCanvasRef={fadeRef}
      bufferWidth={1600}
      bufferHeight={1200}
      zoom={zoom}
      onZoomChange={() => {}}
    />
  );
}

/** The canvas's translate(x, y) scale(s), as numbers. */
function transformOf(canvas: HTMLCanvasElement) {
  const m = /^translate\((\S+)px, (\S+)px\) scale\(([^,)]+)\)$/.exec(canvas.style.transform);
  if (!m) throw new Error(`not a placement: ${canvas.style.transform}`);
  return { x: Number(m[1]), y: Number(m[2]), s: Number(m[3]) };
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
    vi.advanceTimersByTime(FRAME_MS);
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
    advance(200);
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
    advance(200);
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

// A zoom reports its target at once (the status bar shows it) and the view drawn
// eases there over 150 ms. The in-between frames are the pixels already on the
// canvas, moved and scaled.
describe("zoom easing", () => {
  it("reports a notch's zoom at once and eases the view to it, the cursor's point held", () => {
    const { frame } = mount();
    roll(frame, -100);
    expect(zoomSpy).toHaveBeenLastCalledWith(0.625);
    const canvas = frame.querySelector("canvas")!;
    expect(canvas.style.transform).toBe("translate(0px, 0px) scale(0.5)");

    advance(64);
    const mid = transformOf(canvas);
    expect(mid.s).toBeGreaterThan(0.5);
    expect(mid.s).toBeLessThan(0.625);
    expect((400 - mid.x) / mid.s).toBeCloseTo(800, 6);
    expect((300 - mid.y) / mid.s).toBeCloseTo(600, 6);

    advance(150);
    expect(canvas.style.transform).toBe("translate(-100px, -75px) scale(0.625)");
  });

  it("starts a zoom made mid-way from the view on screen", () => {
    const { frame } = mount();
    roll(frame, -100);
    advance(64);
    const canvas = frame.querySelector("canvas")!;
    const before = canvas.style.transform;

    // The wheel's frame and the easing's land in one commit: the new zoom starts
    // from the view the last frame drew.
    roll(frame, -100);
    expect(canvas.style.transform).toBe(before);

    advance(200);
    expect(zoomSpy).toHaveBeenLastCalledWith(0.78125);
    expect(canvas.style.transform).toBe("translate(-225px, -168.75px) scale(0.78125)");
  });

  it("eases a zoom out to fit", () => {
    const { frame } = mount({ start: 0.625 });
    const canvas = frame.querySelector("canvas")!;
    roll(frame, 100);
    expect(zoomSpy).toHaveBeenLastCalledWith(null);
    expect(transformOf(canvas).s).toBe(0.625);

    advance(200);
    expect(canvas.style.transform).toBe("translate(0px, 0px) scale(0.5)");
  });

  it("zooms at once on small wheel steps, a trackpad pinch", () => {
    const { frame } = mount();
    roll(frame, -20);
    const s = 0.5 * Math.pow(1.25, 0.2);
    expect(zoomSpy).toHaveBeenLastCalledWith(s);
    expect(transformOf(frame.querySelector("canvas")!).s).toBe(s);
  });

  it("cuts under Reduce motion", () => {
    document.documentElement.classList.add("sl-reduce-motion");
    const { frame } = mount();
    roll(frame, -100);
    expect(frame.querySelector("canvas")!.style.transform).toBe(
      "translate(-100px, -75px) scale(0.625)",
    );
  });

  it("eases the keyboard's zooms", () => {
    const { frame } = mount();
    const canvas = frame.querySelector("canvas")!;
    act(() => viewportZoomCommands()!.zoom100());
    expect(canvas.style.transform).toBe("translate(0px, 0px) scale(0.5)");

    advance(200);
    expect(canvas.style.transform).toBe("translate(-400px, -300px) scale(1)");
  });

  it("eases a zoom the parent makes (the status bar)", () => {
    const view = render(<Controlled zoom={null} />);
    const canvas = view.container.querySelector("canvas")!;
    view.rerender(<Controlled zoom={1} />);
    expect(canvas.style.transform).toBe("translate(0px, 0px) scale(0.5)");

    advance(200);
    expect(canvas.style.transform).toBe("translate(-400px, -300px) scale(1)");
  });

  it("opens a new photo at its zoom without easing", () => {
    const view = render(<Host />);
    const frame = view.container.firstElementChild as HTMLElement;
    roll(frame, -100);
    advance(200);

    view.rerender(<Host resetKey="next" />);
    expect(frame.querySelector("canvas")!.style.transform).toBe(
      "translate(0px, 0px) scale(0.5)",
    );
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
    if (canvasContext) {
      Object.defineProperty(HTMLCanvasElement.prototype, "getContext", canvasContext);
    }
  });

  it("fades the Presets hover on the overlay it is handed, over 220 ms", () => {
    const view = render(<FadeHost token={0} />);
    const [canvas, overlay] = view.container.querySelectorAll("canvas");
    expect(overlay).toBe(handed);

    view.rerender(<FadeHost token={1} />);
    advance(2 * FRAME_MS);

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

// The canvas is placed by the window of the image it holds, mapped through the view
// drawn, so pixels drawn for one view show where they belong in the next. Before,
// past the cover scale it filled the frame while it still held the whole fit image:
// the whole picture showed stretched over the frame until the zoomed frame came,
// which read as a zoom out before the zoom in.
describe("placement and the colour-assessment mat", () => {
  let canvasContext: PropertyDescriptor | undefined;
  let overlay: HTMLCanvasElement | null;
  let canvas: HTMLCanvasElement | null;
  const HALF: ImageWindow = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
  const asksForWindows = () => {};

  interface PlacedProps {
    zoom: number | null;
    roi?: boolean;
    win?: ImageWindow | null;
    fadeInCommit?: boolean;
    buffer?: number;
    assess?: boolean;
    onViewport?: (roi: ImageWindow | null, outW: number, outH: number) => void;
    onLayout?: (
      visible: { x: number; y: number; w: number; h: number },
      image: { x: number; y: number; w: number; h: number },
      frame: { w: number; h: number },
    ) => void;
  }

  // `fadeInCommit` starts a fade from this parent's layout effect, which runs after
  // the viewport's own in the same commit, as the develop renderer's does.
  function Placed({
    zoom,
    roi = true,
    win = null,
    fadeInCommit = false,
    buffer = 1600,
    assess,
    onViewport,
    onLayout,
  }: PlacedProps) {
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
        bufferWindow={win}
        zoom={zoom}
        onZoomChange={() => {}}
        onViewport={onViewport ?? (roi ? asksForWindows : undefined)}
        colorAssessment={assess}
        onLayout={onLayout}
      />
    );
  }

  beforeEach(() => {
    overlay = null;
    canvas = null;
    canvasContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: () => ({ drawImage: () => {} }),
    });
  });

  afterEach(() => {
    if (canvasContext) {
      Object.defineProperty(HTMLCanvasElement.prototype, "getContext", canvasContext);
    }
  });

  const fading = () => overlay?.style.transition === "opacity 150ms ease-out";

  function fadeNow() {
    if (!canvas || !overlay) throw new Error("not mounted");
    snapshotCrossfade(canvas, overlay, 150);
    advance(2 * FRAME_MS);
    expect(fading()).toBe(true);
  }

  it("keeps a whole-image buffer at the zoomed image rect past the cover scale", () => {
    const view = render(<Placed zoom={null} />);
    view.rerender(<Placed zoom={1} />);
    advance(200);

    expect(canvas?.style.width).toBe("1600px");
    expect(canvas?.style.transform).toBe("translate(-400px, -300px) scale(1)");
  });

  it("places a window buffer at its window under the view", () => {
    const view = render(<Placed zoom={null} />);
    view.rerender(<Placed zoom={1} win={HALF} buffer={1000} />);
    advance(200);

    // The window's 800×600 image px fill the frame from a 1000×750 buffer.
    expect(canvas?.style.transform).toBe("translate(0px, 0px) scale(0.8)");
  });

  it("shows a stale window buffer where it belongs at fit, keeping the fit scale", () => {
    const onLayout = vi.fn();
    const view = render(<Placed zoom={null} onLayout={onLayout} />);
    view.rerender(<Placed zoom={1} win={HALF} buffer={1000} onLayout={onLayout} />);
    view.rerender(<Placed zoom={null} win={HALF} buffer={1000} onLayout={onLayout} />);
    advance(200);

    expect(canvas?.style.transform).toBe("translate(200px, 150px) scale(0.4)");
    expect(onLayout).toHaveBeenLastCalledWith(
      { x: 200, y: 150, w: 400, h: 300 },
      { x: 0, y: 0, w: 800, h: 600 },
      { w: FRAME.w, h: FRAME.h },
    );
  });

  // The overlay is placed like the canvas and holds a copy of the same window, so a
  // view change moves both together; a frame of another window cuts the fade in the
  // develop renderer.
  it("keeps a fade running as the view moves, the overlay placed like the canvas", () => {
    const view = render(<Placed zoom={null} />);
    fadeNow();

    view.rerender(<Placed zoom={1} />);
    advance(FRAME_MS);

    expect(fading()).toBe(true);
    expect(overlay?.style.transform).toBe(canvas?.style.transform);
  });

  // The pixels on screen cover every view a zoom-in passes through, scaled up, so
  // the crisp window waits for the view to settle; a zoom-out's wider frame is
  // asked for at once, to cover the views it widens through.
  it("asks for a zoom-in's window only once it settles", () => {
    const onViewport = vi.fn();
    const view = render(<Placed zoom={null} onViewport={onViewport} />);
    view.rerender(<Placed zoom={1} onViewport={onViewport} />);
    expect(onViewport).toHaveBeenLastCalledWith(null, 0, 0);

    advance(200);
    expect(onViewport).toHaveBeenLastCalledWith(HALF, 800, 600);
  });

  it("asks for a zoom-out's whole image at once", () => {
    const onViewport = vi.fn();
    const view = render(<Placed zoom={1} onViewport={onViewport} />);
    expect(onViewport.mock.lastCall?.[0]).not.toBeNull();

    view.rerender(<Placed zoom={null} onViewport={onViewport} />);
    expect(onViewport).toHaveBeenLastCalledWith(null, 0, 0);
  });

  it("lets a fade run while the view keeps its layout", async () => {
    const view = render(<Placed zoom={null} roi={false} />);
    fadeNow();

    view.rerender(<Placed zoom={1} roi={false} />);
    expect(fading()).toBe(true);
    await act(async () => {
      view.rerender(<Placed zoom={1} roi={false} buffer={1200} fadeInCommit />);
    });
    advance(2 * FRAME_MS);

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
