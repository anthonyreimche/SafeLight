// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { usePickDragStore } from "@/modules/develop/pick-drag";
import { useDevelopStore } from "@/state/develop-store";

const capture = vi.hoisted(() => vi.fn());
vi.mock("./develop-host", async (actual) => ({ ...(await actual<typeof import("./develop-host")>()), captureDevelopFrame: capture }));

import { colourFieldFor, sampleCapture } from "./colour-field-host";
import { makeScopedAPI } from "./host";

/** A width×height frame, every pixel `rgba`, read back through a stand-in
 *  OffscreenCanvas that records what was drawn from it. */
function frame(width: number, height: number, rgba: [number, number, number, number]) {
  const close = vi.fn();
  return { bitmap: { width, height, close }, close, rgba };
}

let drawn: number[] = [];

beforeEach(() => {
  drawn = [];
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      width: number;
      height: number;
      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
      }
      getContext() {
        const { width, height } = this;
        let rgba = [0, 0, 0, 255];
        return {
          drawImage: (src: { rgba: number[] }, sx: number, sy: number, sw: number, sh: number) => {
            drawn = [sx, sy, sw, sh];
            rgba = src.rgba;
          },
          getImageData: () => {
            const data = new Uint8ClampedArray(width * height * 4);
            for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
            return { data };
          },
        };
      }
    },
  );
  useDevelopStore.setState({ photoId: "p1" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  capture.mockReset();
  usePickDragStore.setState({ held: null });
});

describe("sampleCapture", () => {
  it("captures with the bag and averages the patch around the point", async () => {
    const f = frame(100, 50, [255, 0, 0, 255]);
    capture.mockResolvedValue({ ...f.bitmap, rgba: f.rgba });
    const rgb = await sampleCapture({ x: 1.6, y: 10.2 }, { "ext.opacity": 0 });
    expect(capture.mock.calls[0][1]).toEqual({ paramBag: { "ext.opacity": 0 } });
    expect(drawn).toEqual([0, 8, 4, 5]);
    expect(rgb).toEqual([1, 0, 0]);
    expect(f.close).toHaveBeenCalled();
  });

  it("applies the bag to the copies of its stages inside masks, and creates none", async () => {
    const f = frame(100, 50, [255, 0, 0, 255]);
    capture.mockResolvedValue({ ...f.bitmap, rgba: f.rgba });
    const params = useDevelopStore.getState().params;
    const masks = [
      { ...params.masks[0], id: "a", bag: { "ext.tint.hue": 40 } },
      { ...params.masks[0], id: "b", bag: { "other.stage.amount": 5 } },
      { ...params.masks[0], id: "c" },
    ];
    useDevelopStore.setState({ params: { ...params, masks: masks as typeof params.masks }, previewParams: null });
    await sampleCapture({ x: 5, y: 5 }, { "ext.tint.on": 0 });
    const sent = capture.mock.calls[0][0] as typeof params;
    expect(sent.masks.map((m) => m.bag)).toEqual([
      { "ext.tint.hue": 40, "ext.tint.on": 0 },
      { "other.stage.amount": 5 },
      undefined,
    ]);
    expect(useDevelopStore.getState().params.masks[0].bag).toEqual({ "ext.tint.hue": 40 });
  });

  it("is null off the frame, for the blank frame, and after a photo switch", async () => {
    const f = frame(100, 50, [255, 0, 0, 255]);
    capture.mockResolvedValue({ ...f.bitmap, rgba: f.rgba });
    expect(await sampleCapture({ x: 120, y: 10 }, {})).toBeNull();

    capture.mockResolvedValue({ width: 1, height: 1, close: vi.fn(), rgba: f.rgba });
    expect(await sampleCapture({ x: 0, y: 0 }, {})).toBeNull();

    capture.mockImplementation(async () => {
      useDevelopStore.setState({ photoId: "p2" });
      return { ...f.bitmap, rgba: f.rgba };
    });
    expect(await sampleCapture({ x: 5, y: 5 }, {})).toBeNull();
    expect(f.close).toHaveBeenCalled();
  });
});

describe("api.develop.sampleView", () => {
  it("samples the view with the extension's bag, as the ColourField eyedropper does", async () => {
    const f = frame(100, 50, [0, 255, 0, 255]);
    capture.mockResolvedValue({ ...f.bitmap, rgba: f.rgba });
    const rgb = await makeScopedAPI("acme").develop.sampleView({ x: 10, y: 10 }, { "acme.lut.active": 0 });
    expect(capture.mock.calls[0][1]).toEqual({ paramBag: { "acme.lut.active": 0 } });
    expect(rgb).toEqual([0, 1, 0]);
    expect(f.close).toHaveBeenCalled();
  });

  it("samples the view as drawn without a bag", async () => {
    const f = frame(100, 50, [0, 0, 255, 255]);
    capture.mockResolvedValue({ ...f.bitmap, rgba: f.rgba });
    expect(await makeScopedAPI("acme").develop.sampleView({ x: 10, y: 10 })).toEqual([0, 0, 1]);
    expect(capture.mock.calls[0][1]).toEqual({ paramBag: {} });
  });
});

describe("colourFieldFor", () => {
  it("holds the pick-drag tool in the extension's name", () => {
    const Field = colourFieldFor("ext.colour");
    render(<Field label="Tint" hue={0} saturation={50} onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Pick Tint from the photo" }));
    expect(usePickDragStore.getState().held?.owner).toBe("ext.colour");
  });
});
