// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Hovering the mask and heal tools over a photo moves only the cursor ring.
// The heal outlines are traced from every painted dab, which is the costly
// part, so a pointer move must not trace them again, and neither may a redraw
// for another reason when the spots and the view are unchanged.
//
// The outline layer is internal, and a <Profiler> around the overlay would
// also count the ring's renders. So outline renders are counted by the work
// every outline render does and the ring never does: mapping an image point
// to the screen (`mat3Apply`, spied pass-through). Each outline render maps
// at least each spot's two anchors; tracing a brush outline also maps every
// dab.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/rendering/transform", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/rendering/transform")>();
  return { ...real, mat3Apply: vi.fn(real.mat3Apply) };
});

import { act, fireEvent, render } from "@testing-library/react";
import type { BrushDab, CropRect, Mask, RetouchSpot } from "@/catalog/types";
import { DEFAULT_MASK_PANELS, defaultMaskAdjustments } from "@/catalog/types";
import { mat3Apply, type Mat3 } from "@/rendering/transform";
import { useDevelopStore } from "@/state/develop-store";
import { MaskOverlay } from "./MaskOverlay";

class SilentChannel {
  postMessage(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

const mapped = vi.mocked(mat3Apply);

interface Geometry {
  rect: { x: number; y: number; w: number; h: number };
  crop: CropRect;
  forward: Mat3;
}

const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const ASPECT = 4 / 3;
const SPOTS = 10;
const DABS = 40;

// DevelopCanvas rebuilds these objects on every render, so each call hands
// out fresh ones with the same numbers.
function view(): Geometry {
  return {
    rect: { x: 40, y: 30, w: 1000, h: 750 },
    crop: { x: 0, y: 0, width: 1, height: 1 },
    forward: [...IDENTITY],
  };
}

function brushSpot(i: number): RetouchSpot {
  const y = 0.08 + i * 0.085;
  const dabs: BrushDab[] = Array.from({ length: DABS }, (_, k) => ({
    x: 0.1 + k * 0.012,
    y,
    radius: 0.02,
    erase: false,
    feather: 0.5,
  }));
  return {
    id: `spot-${i}`,
    shape: "brush",
    mode: "heal",
    visible: true,
    dstX: dabs[0].x,
    dstY: y,
    srcX: dabs[0].x + 0.6,
    srcY: y,
    radius: 0.02,
    feather: 50,
    opacity: 100,
    dabs,
  };
}

const INITIAL = useDevelopStore.getState();

function seedRetouch(): RetouchSpot[] {
  const retouch = Array.from({ length: SPOTS }, (_, i) => brushSpot(i));
  useDevelopStore.setState({
    activeTool: "retouch",
    retouchSize: 0.04,
    params: { ...INITIAL.params, retouch },
  });
  return retouch;
}

function radialMask(): Mask {
  return {
    id: "mask-1",
    name: "Radial",
    visible: true,
    invert: false,
    opacity: 100,
    adj: defaultMaskAdjustments(),
    panels: [...DEFAULT_MASK_PANELS],
    components: [
      {
        id: "comp-1",
        kind: "radial",
        mode: "add",
        invert: false,
        radial: { cx: 0.5, cy: 0.5, rx: 0.2, ry: 0.2, feather: 0.5, angle: 0 },
      },
    ],
  };
}

function renderOverlay(geometry: Geometry = view()) {
  const ui = (g: Geometry) => (
    <MaskOverlay
      rect={g.rect}
      crop={g.crop}
      inv={IDENTITY}
      forward={g.forward}
      imageAspect={ASPECT}
    />
  );
  const result = render(ui(geometry));
  const overlay = result.container.firstElementChild;
  if (!overlay) throw new Error("MaskOverlay rendered nothing");
  return {
    overlay,
    rerender: (g: Geometry) => result.rerender(ui(g)),
    circles: () => [...result.container.querySelectorAll("circle")],
    paths: () =>
      [...result.container.querySelectorAll("path")].map((p) => p.getAttribute("d")),
  };
}

// jsdom lays nothing out, so the overlay sits at the origin and client
// coordinates are overlay coordinates.
function hover(overlay: Element, x: number, y: number, altKey = false) {
  fireEvent.pointerMove(overlay, { pointerId: 1, clientX: x, clientY: y, altKey });
}

beforeEach(() => {
  vi.stubGlobal("BroadcastChannel", SilentChannel);
  useDevelopStore.setState(INITIAL, true);
  mapped.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Heal hover", () => {
  it("moves the ring with the pointer without tracing any outline again", () => {
    seedRetouch();
    const { overlay, circles } = renderOverlay();
    expect(mapped).toHaveBeenCalled();
    mapped.mockClear();

    for (let k = 0; k < 10; k++) hover(overlay, 100 + 20 * k, 200 + 10 * k);

    expect(mapped).not.toHaveBeenCalled();
    const [ring] = circles();
    expect(ring.getAttribute("cx")).toBe("280");
    expect(ring.getAttribute("cy")).toBe("290");
    expect(ring.getAttribute("r")).toBe("30");
  });

  it("hides the ring while a stroke is being painted", () => {
    seedRetouch();
    const { overlay, circles } = renderOverlay();
    hover(overlay, 900, 700);
    expect(circles()).toHaveLength(1);

    fireEvent.pointerDown(overlay, { pointerId: 1, button: 0, clientX: 900, clientY: 700 });
    hover(overlay, 910, 705);

    expect(circles()).toHaveLength(0);
  });

  it("drops the ring when the pointer leaves", () => {
    seedRetouch();
    const { overlay, circles } = renderOverlay();
    hover(overlay, 300, 300);
    expect(circles()).toHaveLength(1);

    fireEvent.pointerLeave(overlay);

    expect(circles()).toHaveLength(0);
  });
});

describe("Heal outlines", () => {
  it("re-maps only the spot anchors when the selection changes", () => {
    const retouch = seedRetouch();
    renderOverlay();
    mapped.mockClear();

    act(() => useDevelopStore.setState({ selectedSpotId: retouch[3].id }));

    expect(mapped).toHaveBeenCalled();
    expect(mapped.mock.calls.length).toBeLessThanOrEqual(2 * SPOTS);
  });

  it("is left alone by an overlay redraw that changes nothing it shows", () => {
    seedRetouch();
    renderOverlay();
    mapped.mockClear();

    act(() => useDevelopStore.setState({ maskToolType: "linear" }));

    expect(mapped).not.toHaveBeenCalled();
  });

  it("reuses the traced outlines for a fresh view with the same numbers", () => {
    seedRetouch();
    const { rerender, paths } = renderOverlay();
    const before = paths();
    mapped.mockClear();

    rerender(view());

    expect(mapped.mock.calls.length).toBeLessThanOrEqual(2 * SPOTS);
    expect(paths()).toEqual(before);
  });

  const changes: [string, (g: Geometry) => void][] = [
    ["zoom", (g) => { g.rect.w = 2000; g.rect.h = 1500; }],
    ["crop", (g) => { g.crop.x = 0.1; }],
    ["transform", (g) => { g.forward[2] = 0.05; }],
  ];
  it.each(changes)("traces the outlines again after a %s change", (_, change) => {
    seedRetouch();
    const { rerender, paths } = renderOverlay();
    const before = paths();
    mapped.mockClear();

    const next = view();
    change(next);
    rerender(next);

    expect(mapped.mock.calls.length).toBeGreaterThanOrEqual(SPOTS * DABS);
    expect(paths()).not.toEqual(before);
  });
});

describe("Mask hover", () => {
  it("shows the subtract ring under Alt and keeps it on the pointer", () => {
    useDevelopStore.setState({ activeTool: "mask", maskToolType: "brush", brushSize: 0.08 });
    const { overlay, circles } = renderOverlay();

    hover(overlay, 400, 300);
    expect(circles()[0].getAttribute("stroke")).toBe("#fff");

    hover(overlay, 420, 310, true);
    const [outer, inner] = circles();
    expect(outer.getAttribute("stroke")).toBe("#ff6b6b");
    expect(outer.getAttribute("stroke-dasharray")).toBe("4 3");
    expect(inner.getAttribute("stroke")).toBe("#ff6b6b");
    expect([outer.getAttribute("cx"), outer.getAttribute("cy")]).toEqual(["420", "310"]);
    expect(outer.getAttribute("r")).toBe("60");
  });

  it("grows the handle under the pointer on the selected component", () => {
    const mask = radialMask();
    useDevelopStore.setState({
      activeTool: "mask",
      maskToolType: "radial",
      params: { ...INITIAL.params, masks: [mask] },
      selectedMaskId: mask.id,
      selectedComponentId: mask.components[0].id,
    });
    const { overlay, circles } = renderOverlay();
    const eastHandle = () =>
      circles().find((c) => c.getAttribute("cx") === "740" && c.getAttribute("cy") === "405");
    expect(eastHandle()?.getAttribute("r")).toBe("5");

    hover(overlay, 742, 404);

    expect(eastHandle()?.getAttribute("r")).toBe("6");
  });
});
