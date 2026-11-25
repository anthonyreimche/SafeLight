// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The official brush ring (api.develop.BrushCursor), drawn by a canvas tool's
// overlay: Masking's two rings, sized as the brush paints in the photo.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DevelopOverlayProvider, type DevelopOverlayState } from "@/extensions/develop-host";
import { BrushCursor } from "./BrushCursor";

// A 400 × 300 photo shown at 1:1 from the overlay's top left.
const SHOWN: DevelopOverlayState = {
  rect: { x: 0, y: 0, w: 400, h: 300 },
  imageRect: { x: 0, y: 0, w: 400, h: 300 },
  nonce: 1,
  toScreen: (u, v) => ({ x: u * 400, y: v * 300 }),
  toImage: (x, y) => ({ x: x / 400, y: y / 300 }),
  radiusToScreen: (r) => r * 300,
  radiusToImage: (px) => px / 300,
  region: { x: 0, y: 0, width: 1, height: 1 },
  imageAspect: 4 / 3,
  zoomScale: 1,
};

function ringsIn(container: HTMLElement) {
  return [...container.querySelectorAll("ellipse")].map((e) => ({
    cx: Number(e.getAttribute("cx")),
    cy: Number(e.getAttribute("cy")),
    rx: Number(e.getAttribute("rx")),
    ry: Number(e.getAttribute("ry")),
    stroke: e.getAttribute("stroke"),
    dash: e.getAttribute("stroke-dasharray"),
  }));
}

const draw = (props: Parameters<typeof BrushCursor>[0], overlay = SHOWN) =>
  render(
    <DevelopOverlayProvider value={overlay}>
      <BrushCursor {...props} />
    </DevelopOverlayProvider>,
  ).container;

describe("BrushCursor", () => {
  it("draws the brush's edge and its feathered core at the pointer, at the size it paints", () => {
    const [edge, core] = ringsIn(draw({ at: { x: 120, y: 80 }, size: 0.1, feather: 0.5 }));
    expect(edge).toMatchObject({ cx: 120, cy: 80, stroke: "#fff", dash: null });
    expect(edge.rx).toBeCloseTo(30);
    expect(edge.ry).toBeCloseTo(30);
    expect(core.rx).toBeCloseTo(15);
    expect(core.ry).toBeCloseTo(15);
  });

  it("draws an erasing brush red and dashed", () => {
    const [edge] = ringsIn(draw({ at: { x: 10, y: 10 }, size: 0.1, feather: 0, erase: true }));
    expect(edge).toMatchObject({ stroke: "#ff6b6b", dash: "4 3" });
  });

  it("sits at the view's centre as the reference a size slider shows", () => {
    const [edge] = ringsIn(draw({ at: "centre", size: 0.1, feather: 0.5 }));
    expect(edge).toMatchObject({ cx: 200, cy: 150 });
  });

  it("draws nothing off the canvas or before the view is laid out", () => {
    expect(ringsIn(draw({ at: null, size: 0.1, feather: 0.5 }))).toEqual([]);
    const unlaid = { ...SHOWN, rect: null, imageRect: null, toScreen: null, toImage: null };
    expect(ringsIn(draw({ at: { x: 1, y: 1 }, size: 0.1, feather: 0.5 }, unlaid))).toEqual([]);
  });

  it("follows a transform that stretches the photo: the ring is the ellipse a round dab paints", () => {
    const stretched = { ...SHOWN, toScreen: (u: number, v: number) => ({ x: u * 800, y: v * 300 }), toImage: (x: number, y: number) => ({ x: x / 800, y: y / 300 }) };
    const [edge] = ringsIn(draw({ at: { x: 50, y: 50 }, size: 0.1, feather: 0.5 }, stretched));
    expect(Math.max(edge.rx, edge.ry)).toBeCloseTo(60);
    expect(Math.min(edge.rx, edge.ry)).toBeCloseTo(30);
  });
});
