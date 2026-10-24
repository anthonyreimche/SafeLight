// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The Colour Range eyedropper asks the render worker for the scene-linear colour
// under the cursor. The overlay's pointer is in frame px, and the worker wants a
// point across the live frame buffer, so a click maps through the rect where that
// buffer is placed: all of the image at fit, only the zoom window once zoomed in.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import type { Mask } from "@/catalog/types";
import { DEFAULT_MASK_PANELS, defaultColorRange, defaultMaskAdjustments } from "@/catalog/types";
import { disposeRenderBridge } from "@/rendering/render-bridge";
import type { WorkerRequest, WorkerResponse } from "@/rendering/render-worker";
import type { Mat3 } from "@/rendering/transform";
import { useDevelopStore } from "@/state/develop-store";
import { MaskOverlay } from "./MaskOverlay";

class SilentChannel {
  postMessage(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

type Rgb = [number, number, number];
const SCENE_COLOUR: Rgb = [0.42, 0.18, 0.07];

// Answers each probe with SCENE_COLOUR, as the render worker does for a live frame:
// at once, or while `holding` only when the test calls `release`.
class ProbeWorker {
  static posted: WorkerRequest[] = [];
  static holding = false;
  static release: (() => void) | null = null;
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;

  postMessage(msg: WorkerRequest): void {
    ProbeWorker.posted.push(msg);
    if (msg.cmd !== "probe") return;
    const reply: WorkerResponse = { type: "probed", reqId: msg.reqId, rgb: SCENE_COLOUR };
    const answer = () => this.onmessage?.({ data: reply } as MessageEvent<WorkerResponse>);
    if (ProbeWorker.holding) ProbeWorker.release = answer;
    else queueMicrotask(answer);
  }

  terminate(): void {}
}

const probes = () => ProbeWorker.posted.flatMap((m) => (m.cmd === "probe" ? [m] : []));

const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
// The photo zoomed in: its full-image rect reaches far past the 1000×800 frame, and
// the buffer holds the window that fills the frame.
const IMAGE_RECT = { x: -300, y: -200, w: 3000, h: 2000 };
const WINDOW_RECT = { x: 0, y: 0, w: 1000, h: 800 };

const INITIAL = useDevelopStore.getState();

function colourRangeMask(): Mask {
  return {
    id: "mask-1",
    name: "Colour",
    visible: true,
    invert: false,
    opacity: 100,
    adj: defaultMaskAdjustments(),
    panels: [...DEFAULT_MASK_PANELS],
    components: [
      { id: "comp-1", kind: "colorRange", mode: "add", invert: false, colorRange: defaultColorRange() },
    ],
  };
}

function pickingColour() {
  const mask = colourRangeMask();
  useDevelopStore.setState({
    photoId: "a",
    activeTool: "mask",
    maskColorPicking: true,
    params: { ...INITIAL.params, masks: [mask] },
    selectedMaskId: mask.id,
    selectedComponentId: mask.components[0].id,
  });
  const { container } = render(
    <MaskOverlay
      rect={IMAGE_RECT}
      bufferRect={WINDOW_RECT}
      crop={{ x: 0, y: 0, width: 1, height: 1 }}
      inv={IDENTITY}
      forward={IDENTITY}
      imageAspect={1.5}
    />,
  );
  const overlay = container.firstElementChild;
  if (!overlay) throw new Error("MaskOverlay rendered nothing");
  return overlay;
}

// jsdom lays nothing out, so the overlay sits at the origin and client
// coordinates are frame coordinates.
const click = (overlay: Element, x: number, y: number) =>
  fireEvent.pointerDown(overlay, { pointerId: 1, button: 0, clientX: x, clientY: y });

const target = () => {
  const { colorRange } = useDevelopStore.getState().params.masks[0].components[0];
  return colorRange && [colorRange.r, colorRange.g, colorRange.b];
};

beforeEach(() => {
  ProbeWorker.posted = [];
  ProbeWorker.holding = false;
  ProbeWorker.release = null;
  vi.stubGlobal("BroadcastChannel", SilentChannel);
  vi.stubGlobal("Worker", ProbeWorker);
  useDevelopStore.setState(INITIAL, true);
});

afterEach(() => {
  disposeRenderBridge();
  vi.unstubAllGlobals();
});

describe("Colour Range eyedropper", () => {
  it("asks for the mask colour at the click's place across the frame buffer", async () => {
    const overlay = pickingColour();

    click(overlay, 250, 600);

    await waitFor(() => expect(probes()).toHaveLength(1));
    const [probe] = probes();
    expect(probe.point).toBe("mask");
    expect(probe.u).toBeCloseTo(0.25);
    expect(probe.v).toBeCloseTo(0.75);
  });

  it("stores the colour it was given as the component's target, as one step", async () => {
    const overlay = pickingColour();

    click(overlay, 250, 600);

    await waitFor(() => expect(target()).toEqual(SCENE_COLOUR));
    await waitFor(() =>
      expect(useDevelopStore.getState().history.map((h) => h.label)).toContain("Colour Range Pick"),
    );
    expect(useDevelopStore.getState().maskColorPicking).toBe(false);
  });

  it("picks nothing from the surround beyond the frame buffer, and stops picking", () => {
    const overlay = pickingColour();
    const before = target();

    click(overlay, 1100, 600);

    expect(probes()).toEqual([]);
    expect(target()).toEqual(before);
    expect(useDevelopStore.getState().maskColorPicking).toBe(false);
  });

  // The worker answers after the user has moved on.
  describe("when the colour comes back late", () => {
    beforeEach(() => {
      ProbeWorker.holding = true;
    });

    const answer = async () => {
      act(() => ProbeWorker.release?.());
      await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    };

    it("leaves the photo opened meanwhile alone", async () => {
      click(pickingColour(), 250, 600);
      // Its mask carries the same ids, as one synced from the first does.
      act(() => useDevelopStore.setState({ photoId: "b", params: { ...INITIAL.params, masks: [colourRangeMask()] } }));

      await answer();

      const { r, g, b } = defaultColorRange();
      expect(target()).toEqual([r, g, b]);
      expect(useDevelopStore.getState().history.map((h) => h.label)).not.toContain("Colour Range Pick");
    });

    it("keeps what was changed on the component meanwhile", async () => {
      click(pickingColour(), 250, 600);
      act(() =>
        useDevelopStore.getState().updateComponent("mask-1", "comp-1", {
          colorRange: { ...defaultColorRange(), hueRange: 0.4 },
        }),
      );

      await answer();

      expect(target()).toEqual(SCENE_COLOUR);
      expect(useDevelopStore.getState().params.masks[0].components[0].colorRange?.hueRange).toBe(0.4);
    });
  });
});
