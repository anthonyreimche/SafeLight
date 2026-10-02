// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Tone curve editor point handling. End points move freely in both axes (like
// Photoshop/ACR): the black point slides right along the bottom to clip
// shadows or up the left edge to lift them, the white point mirrors that, and
// neither can pass its neighbour or be removed.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { defaultToneCurves } from "@/catalog/types";
import type { CurvePoint, ToneCurveChannel, ToneCurves } from "@/catalog/types";
import { activateAccessibility, deactivateAccessibility } from "@/state/accessibility";
import { updateSettings } from "@/state/settings-store";
import { CurveEditor } from "./CurveEditor";

// The editor's 8px padding around a 200px plot.
const PAD = 8;
const PLOT = 200;
const SIZE = PLOT + 2 * PAD;

class FixedWidthObserver {
  private readonly cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(): void {
    this.cb([{ contentRect: { width: SIZE } }] as never, this as never);
  }
  unobserve(): void {}
  disconnect(): void {}
}

// jsdom has no 2D canvas; drawing only has to not throw.
const noopContext = new Proxy({}, { get: () => () => {}, set: () => true });

const realGetContext = HTMLCanvasElement.prototype.getContext;
const realRect = HTMLCanvasElement.prototype.getBoundingClientRect;

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", FixedWidthObserver);
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => noopContext,
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: SIZE,
      bottom: SIZE,
      width: SIZE,
      height: SIZE,
      toJSON: () => ({}),
    }),
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: realGetContext,
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: realRect,
  });
});

// Canvas-space coordinates of a curve-space point.
const at = (x: number, y: number) => ({
  clientX: PAD + x * PLOT,
  clientY: PAD + (1 - y) * PLOT,
});

function Harness({
  rgb,
  onChange,
}: {
  rgb: CurvePoint[];
  onChange: (channel: ToneCurveChannel, points: CurvePoint[]) => void;
}) {
  const [curves, setCurves] = useState<ToneCurves>({ ...defaultToneCurves(), rgb });
  return (
    <CurveEditor
      curves={curves}
      onChange={(channel, points) => {
        onChange(channel, points);
        setCurves((c) => ({ ...c, [channel]: points }));
      }}
      onCommit={() => {}}
    />
  );
}

function setup(rgb: CurvePoint[]) {
  const onChange = vi.fn<(channel: ToneCurveChannel, points: CurvePoint[]) => void>();
  render(<Harness rgb={rgb} onChange={onChange} />);
  const canvas = screen.getByLabelText(/^Tone curve,/);
  const lastPoints = () => onChange.mock.lastCall?.[1];
  return { user: userEvent.setup(), onChange, canvas, lastPoints };
}

const IDENTITY: CurvePoint[] = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];

describe("CurveEditor end points", () => {
  const drag = (
    user: ReturnType<typeof userEvent.setup>,
    target: Element,
    from: { clientX: number; clientY: number },
    to: { clientX: number; clientY: number },
  ) =>
    user.pointer([
      { keys: "[MouseLeft>]", target, coords: from },
      { target, coords: to },
      { keys: "[/MouseLeft]", target, coords: to },
    ]);

  it("drags the black point right along the bottom edge", async () => {
    const { user, canvas, lastPoints } = setup(IDENTITY);
    await drag(user, canvas, at(0, 0), at(0.25, 0));
    expect(lastPoints()?.[0]).toEqual({ x: 0.25, y: 0 });
  });

  it("drags the white point left along the top edge", async () => {
    const { user, canvas, lastPoints } = setup(IDENTITY);
    await drag(user, canvas, at(1, 1), at(0.8, 1));
    expect(lastPoints()?.[1]).toEqual({ x: 0.8, y: 1 });
  });

  it("moves an end point in both axes at once", async () => {
    const { user, canvas, lastPoints } = setup(IDENTITY);
    await drag(user, canvas, at(0, 0), at(0.2, 0.15));
    const black = lastPoints()?.[0];
    expect(black?.x).toBeCloseTo(0.2, 9);
    expect(black?.y).toBeCloseTo(0.15, 9);
  });

  it("stops an end point just short of its neighbour", async () => {
    const { user, canvas, lastPoints } = setup([
      { x: 0, y: 0 },
      { x: 0.5, y: 0.5 },
      { x: 1, y: 1 },
    ]);
    await drag(user, canvas, at(0, 0), at(0.9, 0));
    expect(lastPoints()?.[0].x).toBeCloseTo(0.499, 9);
    await drag(user, canvas, at(1, 1), at(0.1, 1));
    expect(lastPoints()?.[2].x).toBeCloseTo(0.501, 9);
  });

  it("keeps a moved end point on double-click", () => {
    const { canvas, onChange } = setup([
      { x: 0.25, y: 0 },
      { x: 1, y: 1 },
    ]);
    fireEvent.doubleClick(canvas, at(0.25, 0));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("CurveEditor end points with keyboard canvas editing", () => {
  beforeAll(() => {
    updateSettings({ keyboardCanvasEditing: true });
    activateAccessibility();
  });
  afterAll(() => {
    deactivateAccessibility();
    updateSettings({ keyboardCanvasEditing: false });
  });
  afterEach(() => vi.clearAllMocks());

  it("nudges the selected black point right with the arrow key", async () => {
    const { user, canvas, lastPoints } = setup(IDENTITY);
    canvas.focus();
    await user.keyboard("{ArrowRight}");
    expect(lastPoints()?.[0].x).toBeCloseTo(0.01, 9);
  });

  it("sets an end point's input level from the In field", async () => {
    const { user, lastPoints } = setup(IDENTITY);
    const input = screen.getByLabelText<HTMLInputElement>(
      "Selected point input level (%)",
    );
    expect(input.disabled).toBe(false);
    await user.clear(input);
    await user.type(input, "30");
    expect(lastPoints()?.[0]).toEqual({ x: 0.3, y: 0 });
  });
});
