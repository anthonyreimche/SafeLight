// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A picture handed to the canvas eases in over the one before only when the renderer
// says so (a frame armed by a discrete edit) or when it is the next tier of the photo.
// Every other frame of the photo (a drag's, the clipping toggle's) cuts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { RenderBridge } from "@/rendering/render-bridge";
import { cancelCrossfade, snapshotCrossfade } from "@/ui/canvas-crossfade";
import { useDevelopPicture, type DevelopTier, type Picture } from "./use-develop-picture";

vi.mock("@/ui/canvas-crossfade", () => ({
  snapshotCrossfade: vi.fn(() => true),
  cancelCrossfade: vi.fn(),
}));
vi.mock("@/ui/canvas-handover", () => ({ endHandover: vi.fn() }));

function bitmap(width: number, height: number): ImageBitmap {
  return { width, height, close: () => undefined } as ImageBitmap;
}

function picture(tier: DevelopTier, fade?: number): Picture {
  return { bitmap: bitmap(400, 300), width: 400, height: 300, tier, window: null, whole: null, crop: null, fade };
}

// Each test opens its photo on a bridge of its own, so no quick-switch note from
// another test holds its tiers back.
function setup() {
  const canvas = document.createElement("canvas");
  const overlay = document.createElement("canvas");
  const view = renderHook(() =>
    useDevelopPicture({ current: canvas }, { current: overlay }),
  );
  view.result.current.ctxRef.current = { drawImage: () => undefined } as unknown as CanvasRenderingContext2D;
  act(() => view.result.current.beginPhoto({} as RenderBridge, "p1"));
  const show = (next: Picture) => act(() => view.result.current.present(next));
  return { canvas, overlay, show };
}

beforeEach(() => {
  vi.mocked(snapshotCrossfade).mockClear();
  vi.mocked(cancelCrossfade).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the develop picture's fades", () => {
  it("eases in a frame handed a fade, over the length it is handed", () => {
    const { canvas, overlay, show } = setup();
    show(picture("final"));
    expect(snapshotCrossfade).not.toHaveBeenCalled();

    show(picture("final", 140));
    expect(snapshotCrossfade).toHaveBeenCalledTimes(1);
    expect(snapshotCrossfade).toHaveBeenCalledWith(canvas, overlay, 140);
  });

  it("cuts to a frame handed none", () => {
    const { show } = setup();
    show(picture("final"));
    show(picture("final"));
    show(picture("final"));
    expect(snapshotCrossfade).not.toHaveBeenCalled();
  });

  it("runs one fade, the longer, when a frame is both armed and the next tier", () => {
    const { canvas, overlay, show } = setup();
    show(picture("preview"));
    show(picture("final", 140));
    expect(snapshotCrossfade).toHaveBeenCalledTimes(1);
    expect(snapshotCrossfade).toHaveBeenCalledWith(canvas, overlay, 220);
  });

  it("cuts the photo's first picture, armed or not", () => {
    const { show } = setup();
    show(picture("final", 140));
    expect(snapshotCrossfade).not.toHaveBeenCalled();
  });
});
