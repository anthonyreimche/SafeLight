// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Each clipping triangle flips its own bit of the overlay, so turning one off
// leaves the others as they were, the gamut warning (bit 2) included, unless that
// leaves neither triangle on: then the overlay is off, as the Clip button says.
// jsdom has no layout, so the canvas reads as the component's default 220 px wide.

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import type { ClippingMask } from "@/state/develop-slices/view-slice";
import { Histogram } from "./Histogram";

const BINS = new Uint32Array(256);
const CLIPPED_BOTH_ENDS = {
  r: BINS, g: BINS, b: BINS, luma: BINS,
  extended: { r: BINS, g: BINS, b: BINS, luma: BINS, rangeMin: 0, rangeMax: 1, clipLow: 0.05, clipHigh: 0.05 },
};

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe(): void {} disconnect(): void {} });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const SHADOW_X = 10;
const HIGHLIGHT_X = 210;

/** The mask the Histogram asks for when the triangle at `clientX` is clicked on `showClipping`. */
function clicked(showClipping: ClippingMask, clientX: number): ClippingMask {
  const onSetClipping = vi.fn<(mode: ClippingMask) => void>();
  const { container } = render(
    <Histogram data={CLIPPED_BOTH_ENDS} showClipping={showClipping} onSetClipping={onSetClipping} />,
  );
  const canvas = container.querySelector("canvas");
  if (!canvas) throw new Error("no canvas");
  fireEvent.pointerDown(canvas, { button: 0, clientX, clientY: 4 });
  expect(onSetClipping).toHaveBeenCalledTimes(1);
  return onSetClipping.mock.calls[0][0];
}

it.each([
  ["shadow", SHADOW_X, 6],
  ["highlight", HIGHLIGHT_X, 5],
])("the %s triangle clears its own bit and keeps the gamut warning", (_, clientX, expected) => {
  expect(clicked(7, clientX)).toBe(expected);
});

it.each<[string, number, ClippingMask]>([
  ["shadow", SHADOW_X, 2],
  ["highlight", HIGHLIGHT_X, 1],
])("the %s triangle leaves the other triangle on", (_, clientX, expected) => {
  expect(clicked(3, clientX)).toBe(expected);
});

// A version 1/2 photo never draws bit 2, so a mask of only that bit would leave the
// Clip button lit over a canvas with nothing on it.
it.each<[string, number, ClippingMask]>([
  ["shadow", SHADOW_X, 5],
  ["highlight", HIGHLIGHT_X, 6],
])("the %s triangle turns the overlay off when it was the last one on", (_, clientX, mask) => {
  expect(clicked(mask, clientX)).toBe(0);
});
