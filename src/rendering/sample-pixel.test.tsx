// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The eyedroppers read the Develop canvas. Under a Linux display profile it
// holds monitor values, so the sample is taken back to sRGB-linear and the
// white balance it solves for doesn't depend on the monitor.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildIccProfile } from "./color-space";
import { monitorToSrgbLinear, parseDisplayProfile } from "./display-profile";
import { useDisplayProfile } from "./display-profile-store";
import { sampleLinearRGB } from "./sample-pixel";

const PIXEL = [200, 120, 60];

function canvasOf(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

beforeEach(() => {
  const context = {
    drawImage: () => undefined,
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      data: Uint8ClampedArray.from({ length: w * h * 4 }, (_, i) => PIXEL[i % 4] ?? 255),
    }),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => context as unknown as CanvasRenderingContext2D,
  );
});

afterEach(() => {
  useDisplayProfile.setState({ status: "off" }, true);
  vi.restoreAllMocks();
});

const decode = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));

describe("sampleLinearRGB", () => {
  it("linearises the canvas as sRGB", () => {
    const sample = sampleLinearRGB(canvasOf(16, 16), 8, 8);
    const expected = PIXEL.map((v) => decode(v / 255));
    sample!.forEach((v, c) => expect(v).toBeCloseTo(expected[c], 6));
  });

  it("takes monitor values back to sRGB-linear under a display profile", () => {
    const parsed = parseDisplayProfile(buildIccProfile("adobe-rgb"));
    if (!parsed.ok) throw new Error(parsed.error);
    const { transform } = parsed.profile;
    useDisplayProfile.setState(
      { status: "active", path: "/monitor.icc", description: "", transform },
      true,
    );
    const sample = sampleLinearRGB(canvasOf(16, 16), 8, 8);
    const expected = monitorToSrgbLinear(transform)(PIXEL[0] / 255, PIXEL[1] / 255, PIXEL[2] / 255);
    sample!.forEach((v, c) => expect(v).toBeCloseTo(expected[c], 6));
    expect(Math.abs(sample![0] - decode(PIXEL[0] / 255))).toBeGreaterThan(0.01);
  });
});
