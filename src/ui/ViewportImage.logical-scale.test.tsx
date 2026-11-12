// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The viewport measuring its zoom in more pixels than its whole-image buffer has
// (Develop's Dynamic mode: the photo's own pixels). A 3000×2000 buffer in a
// 1500×1000 frame fits at 0.5; at a logicalScale of 2 the image is 6000×4000 and
// fits at 0.25, and zoom 1 shows a quarter of its width. The picture on screen
// at fit, and wherever a buffer is placed, is the same at either scale.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { useRef, useState } from "react";
import { viewportZoomCommands } from "@/state/viewport-zoom-commands";
import { ViewportImage } from "./ViewportImage";
import type { ImageWindow } from "./viewport-view";

const FRAME = { w: 1500, h: 1000 };
const BUFFER = { w: 3000, h: 2000 };
const FRAME_MS = 16;

class FixedFrameObserver {
  private readonly cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(): void {
    this.cb([{ contentRect: { width: FRAME.w, height: FRAME.h } }] as never, this as never);
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

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

function advance(ms: number) {
  for (let t = 0; t < ms; t += FRAME_MS) {
    act(() => {
      vi.advanceTimersByTime(FRAME_MS);
    });
  }
}

/** The canvas's translate(x, y) scale(s), as numbers. */
function transformOf(canvas: HTMLCanvasElement) {
  const m = /^translate\((\S+)px, (\S+)px\) scale\(([^,)]+)\)$/.exec(canvas.style.transform);
  if (!m) throw new Error(`not a placement: ${canvas.style.transform}`);
  return { x: Number(m[1]), y: Number(m[2]), s: Number(m[3]) };
}

type Layout = (
  visible: { x: number; y: number; w: number; h: number },
  image: { x: number; y: number; w: number; h: number },
  frame: { w: number; h: number },
) => void;

interface PlacedProps {
  zoom: number | null;
  logicalScale?: number;
  win?: ImageWindow | null;
  buffer?: { w: number; h: number };
  whole?: { w: number; h: number };
  onViewport?: (roi: ImageWindow | null, outW: number, outH: number) => void;
  onLayout?: Layout;
}

/** A viewport whose zoom the parent sets. */
function Placed({ zoom, logicalScale, win = null, buffer = BUFFER, whole, onViewport, onLayout }: PlacedProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fadeRef = useRef<HTMLCanvasElement>(null);
  return (
    <ViewportImage
      canvasRef={canvasRef}
      fadeCanvasRef={fadeRef}
      bufferWidth={buffer.w}
      bufferHeight={buffer.h}
      bufferWindow={win}
      imageWidth={whole?.w}
      imageHeight={whole?.h}
      zoom={zoom}
      onZoomChange={() => {}}
      onViewport={onViewport ?? (() => {})}
      onLayout={onLayout}
      logicalScale={logicalScale}
    />
  );
}

const zoomSpy = vi.fn<(zoom: number | null) => void>();

/** A viewport that owns its zoom, as the Develop module does. */
function Host({
  start = null,
  logicalScale,
  onViewport,
  onLayout,
}: {
  start?: number | null;
  logicalScale?: number;
  onViewport?: (roi: ImageWindow | null, outW: number, outH: number) => void;
  onLayout?: Layout;
}) {
  const [zoom, setZoom] = useState<number | null>(start);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fadeRef = useRef<HTMLCanvasElement>(null);
  return (
    <ViewportImage
      canvasRef={canvasRef}
      fadeCanvasRef={fadeRef}
      bufferWidth={BUFFER.w}
      bufferHeight={BUFFER.h}
      zoom={zoom}
      onZoomChange={(z) => {
        zoomSpy(z);
        setZoom(z);
      }}
      initialZoom={start}
      onViewport={onViewport}
      onLayout={onLayout}
      logicalScale={logicalScale}
    />
  );
}

function roll(frame: HTMLElement, deltaY: number, at: { x: number; y: number }) {
  act(() => {
    frame.dispatchEvent(
      new WheelEvent("wheel", { deltaY, clientX: at.x, clientY: at.y, bubbles: true, cancelable: true }),
    );
    vi.advanceTimersByTime(FRAME_MS);
  });
}

const canvasOf = (container: HTMLElement) => container.querySelector("canvas")!;

beforeEach(() => zoomSpy.mockClear());

describe("a logical scale of 1, or none", () => {
  it.each([undefined, 1, 0, -2, Number.NaN, Number.POSITIVE_INFINITY])(
    "fits and zooms by the buffer's pixels (logicalScale %s)",
    (logicalScale) => {
      const onViewport = vi.fn();
      const view = render(<Placed zoom={null} logicalScale={logicalScale} onViewport={onViewport} />);
      expect(canvasOf(view.container).style.transform).toBe("translate(0px, 0px) scale(0.5)");

      view.rerender(<Placed zoom={1} logicalScale={logicalScale} onViewport={onViewport} />);
      advance(200);
      expect(canvasOf(view.container).style.transform).toBe("translate(-750px, -500px) scale(1)");
      expect(onViewport).toHaveBeenLastCalledWith({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 1500, 1000);
    },
  );
});

// The zoom counts device pixels: on a screen scaled 2x, 100% draws each buffer
// pixel on one device pixel, half a CSS px, and the window is asked for at the
// frame's device size.
describe("a scaled screen", () => {
  it("draws one buffer pixel per device pixel at zoom 1", () => {
    const before = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
    Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true });
    try {
      const onViewport = vi.fn();
      const view = render(<Placed zoom={null} onViewport={onViewport} />);
      expect(canvasOf(view.container).style.transform).toBe("translate(0px, 0px) scale(0.5)");

      view.rerender(<Placed zoom={2} onViewport={onViewport} />);
      advance(200);
      expect(canvasOf(view.container).style.transform).toBe("translate(-750px, -500px) scale(1)");
      expect(onViewport).toHaveBeenLastCalledWith({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 3000, 2000);
    } finally {
      if (before) Object.defineProperty(window, "devicePixelRatio", before);
      else Reflect.deleteProperty(window, "devicePixelRatio");
    }
  });
});

// The buffer can hold more pixels than the logical image.
describe("a logical scale under 1", () => {
  it("fits the same on screen, and reaches the buffer's own pixels at twice the zoom", () => {
    const onViewport = vi.fn();
    const view = render(<Placed zoom={null} logicalScale={0.5} onViewport={onViewport} />);
    expect(canvasOf(view.container).style.transform).toBe("translate(0px, 0px) scale(0.5)");

    view.rerender(<Placed zoom={2} logicalScale={0.5} onViewport={onViewport} />);
    advance(200);
    expect(canvasOf(view.container).style.transform).toBe("translate(-750px, -500px) scale(1)");
    expect(onViewport).toHaveBeenLastCalledWith({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 1500, 1000);
  });
});

describe("a logical scale of 2", () => {
  it("fits at a quarter and shows the same picture as at a scale of 1", () => {
    const onLayout = vi.fn();
    const one = render(<Placed zoom={null} onLayout={onLayout} />);
    const atOne = canvasOf(one.container).style.transform;
    const layoutAtOne = onLayout.mock.lastCall;
    one.unmount();

    const two = render(<Placed zoom={null} logicalScale={2} onLayout={onLayout} />);
    expect(canvasOf(two.container).style.transform).toBe(atOne);
    expect(onLayout.mock.lastCall).toEqual(layoutAtOne);
  });

  it("shows a quarter of the image's width at zoom 1, and an eighth at 200%", () => {
    const onViewport = vi.fn();
    const onLayout = vi.fn();
    const view = render(<Placed zoom={null} logicalScale={2} onViewport={onViewport} onLayout={onLayout} />);
    view.rerender(<Placed zoom={1} logicalScale={2} onViewport={onViewport} onLayout={onLayout} />);
    advance(200);
    expect(onViewport).toHaveBeenLastCalledWith({ x: 0.375, y: 0.375, w: 0.25, h: 0.25 }, 1500, 1000);
    expect(onLayout.mock.lastCall?.[1]).toEqual({ x: -2250, y: -1500, w: 6000, h: 4000 });
    // Each buffer pixel covers two of the image's, so two CSS px at zoom 1.
    expect(canvasOf(view.container).style.transform).toBe("translate(-2250px, -1500px) scale(2)");

    view.rerender(<Placed zoom={2} logicalScale={2} onViewport={onViewport} onLayout={onLayout} />);
    advance(200);
    const [roi, outW, outH] = onViewport.mock.lastCall ?? [];
    expect(roi.w).toBeCloseTo(0.125, 12);
    expect(roi.h).toBeCloseTo(0.125, 12);
    expect([outW, outH]).toEqual([1500, 1000]);
  });

  it("goes no further in than 200% of the image's pixels", () => {
    const view = render(<Host logicalScale={2} />);
    const frame = view.container.firstElementChild as HTMLElement;
    act(() => viewportZoomCommands()!.zoom100());
    expect(zoomSpy).toHaveBeenLastCalledWith(1);
    for (let i = 0; i < 6; i++) roll(frame, -100, { x: 750, y: 500 });
    expect(zoomSpy).toHaveBeenLastCalledWith(2);
  });

  it("places a window buffer by its window, as at a scale of 1", () => {
    const HALF: ImageWindow = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
    const props = { win: HALF, buffer: { w: 1000, h: 667 }, whole: BUFFER };
    const one = render(<Placed zoom={null} {...props} />);
    one.rerender(<Placed zoom={1} {...props} />);
    advance(200);
    const atOne = canvasOf(one.container).style.transform;
    expect(atOne).toBe("translate(0px, 0px) scale(1.5, 1.4992503748125936)");
    one.unmount();

    const two = render(<Placed zoom={null} logicalScale={2} {...props} />);
    two.rerender(<Placed zoom={0.5} logicalScale={2} {...props} />);
    advance(200);
    expect(canvasOf(two.container).style.transform).toBe(atOne);
  });
});

// The scale can change with a photo open: the setting turned on or off, a cache
// entry's full size arriving, a RAW and a JPEG. A fitted view stays fitted; a
// zoomed one keeps the picture on screen, its zoom number divided by the change.
describe("a change of logical scale", () => {
  function zoomedOffCentre(logicalScale: number, onLayout: Layout, onViewport = vi.fn()) {
    const view = render(<Host logicalScale={logicalScale} onLayout={onLayout} onViewport={onViewport} />);
    const frame = view.container.firstElementChild as HTMLElement;
    roll(frame, -100, { x: 300, y: 200 });
    advance(200);
    return view;
  }

  it("keeps a fitted view fitted", () => {
    const view = render(<Host />);
    const before = canvasOf(view.container).style.transform;
    view.rerender(<Host logicalScale={2} />);
    view.rerender(<Host logicalScale={1.5} />);
    expect(zoomSpy).not.toHaveBeenCalledWith(expect.any(Number));
    expect(canvasOf(view.container).style.transform).toBe(before);
  });

  it("keeps a zoomed view's picture from 1 to 2, and back", () => {
    const onLayout = vi.fn();
    const onViewport = vi.fn();
    const view = zoomedOffCentre(1, onLayout, onViewport);
    expect(zoomSpy).toHaveBeenLastCalledWith(0.625);
    const canvas = canvasOf(view.container);
    const before = transformOf(canvas);
    const imageBefore = onLayout.mock.lastCall?.[1];
    const roiBefore = onViewport.mock.lastCall?.[0];

    view.rerender(<Host logicalScale={2} onLayout={onLayout} onViewport={onViewport} />);
    expect(zoomSpy).toHaveBeenLastCalledWith(0.3125);
    const after = transformOf(canvas);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
    expect(after.s).toBeCloseTo(before.s, 12);
    const imageAfter = onLayout.mock.lastCall?.[1];
    expect(imageAfter.w).toBeCloseTo(imageBefore.w, 9);
    expect(imageAfter.x).toBeCloseTo(imageBefore.x, 9);
    const roiAfter = onViewport.mock.lastCall?.[0];
    expect(roiAfter.x).toBeCloseTo(roiBefore.x, 12);
    expect(roiAfter.w).toBeCloseTo(roiBefore.w, 12);

    view.rerender(<Host logicalScale={1} onLayout={onLayout} onViewport={onViewport} />);
    expect(zoomSpy).toHaveBeenLastCalledWith(0.625);
    const back = transformOf(canvas);
    expect(back.x).toBeCloseTo(before.x, 9);
    expect(back.s).toBeCloseTo(before.s, 12);
  });

  it("shows the change at once, without easing", () => {
    const view = zoomedOffCentre(1, vi.fn());
    const canvas = canvasOf(view.container);
    const before = transformOf(canvas);
    view.rerender(<Host logicalScale={2} />);
    advance(FRAME_MS);
    expect(transformOf(canvas).s).toBeCloseTo(before.s, 12);
  });

  it("holds a zoom that would pass 200% at 200%, the centre's image point kept", () => {
    const onLayout = vi.fn();
    const view = render(<Host logicalScale={2} onLayout={onLayout} />);
    act(() => viewportZoomCommands()!.zoom100());
    act(() => viewportZoomCommands()!.zoomStep(1));
    act(() => viewportZoomCommands()!.zoomStep(1));
    advance(200);
    expect(zoomSpy).toHaveBeenLastCalledWith(1.5625);
    const centreOf = () => {
      const image = onLayout.mock.lastCall?.[1];
      return { u: (FRAME.w / 2 - image.x) / image.w, v: (FRAME.h / 2 - image.y) / image.h };
    };
    const before = centreOf();

    view.rerender(<Host logicalScale={1} onLayout={onLayout} />);
    expect(zoomSpy).toHaveBeenLastCalledWith(2);
    advance(200);
    const after = centreOf();
    expect(after.u).toBeCloseTo(before.u, 9);
    expect(after.v).toBeCloseTo(before.v, 9);
    expect(onLayout.mock.lastCall?.[1].w).toBeCloseTo(6000, 9);
  });

  // The drag's origin is in the view before the change; a move after it set the
  // offset from there, over the recentred view.
  it("ends a drag in progress, the view staying where the change put it", () => {
    const view = render(<Host start={1} />);
    const frame = view.container.firstElementChild as HTMLElement;
    const canvas = canvasOf(view.container);
    fireEvent.pointerDown(frame, { pointerId: 1, button: 0, clientX: 750, clientY: 500 });
    fireEvent.pointerMove(frame, { pointerId: 1, clientX: 700, clientY: 480 });
    advance(FRAME_MS);

    view.rerender(<Host start={1} logicalScale={2} />);
    const rescaled = canvas.style.transform;
    fireEvent.pointerMove(frame, { pointerId: 1, clientX: 600, clientY: 400 });
    advance(FRAME_MS);
    expect(canvas.style.transform).toBe(rescaled);
    fireEvent.pointerUp(frame, { pointerId: 1, button: 0, clientX: 600, clientY: 400 });
    expect(zoomSpy).not.toHaveBeenLastCalledWith(null);
  });

  // A photo opened at 100% whose full size comes after its first picture (a
  // camera preview first, or an old cache entry) opens at one image pixel per CSS
  // px of the size that came.
  it("keeps the zoom a photo opened at, the centre's image point kept", () => {
    const onLayout = vi.fn();
    const view = render(<Host start={1} onLayout={onLayout} />);
    zoomSpy.mockClear();
    const centreOf = () => {
      const image = onLayout.mock.lastCall?.[1];
      return { u: (FRAME.w / 2 - image.x) / image.w, v: (FRAME.h / 2 - image.y) / image.h };
    };
    const before = centreOf();
    view.rerender(<Host start={1} logicalScale={2} onLayout={onLayout} />);
    expect(zoomSpy).not.toHaveBeenCalled();
    expect(onLayout.mock.lastCall?.[1].w).toBe(6000);
    const after = centreOf();
    expect(after.u).toBeCloseTo(before.u, 9);
    expect(after.v).toBeCloseTo(before.v, 9);
  });
});
