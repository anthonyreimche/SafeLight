// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The Develop status bar's text buttons are 10px words, too small to hit on
// their own. Each takes the shared padded hit box, whose negative margins keep
// the bar's spacing, and the zoom buttons say which stop is on.

import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ZoomControls } from "./ZoomControls";
import { SurroundControl } from "./SurroundControl";
import { STATUS_HIT } from "./status-button";
import { AssessmentToggle } from "@/modules/develop/view-toggles";
import {
  CANVAS_SURROUND_SHADES,
  DEFAULT_CANVAS_SURROUND_INDEX,
  updateSettings,
} from "@/state/settings-store";

const hasHitBox = (el: HTMLElement) =>
  STATUS_HIT.split(" ").every((c) => el.classList.contains(c));

beforeEach(() => {
  updateSettings({
    canvasSurroundOverride: true,
    canvasSurround: CANVAS_SURROUND_SHADES[DEFAULT_CANVAS_SURROUND_INDEX].value,
  });
});

describe("status-bar hit targets", () => {
  it("pads every zoom stop and marks the one in use", () => {
    render(<ZoomControls zoom={1} onChange={() => {}} />);
    for (const name of ["Fit", "25%", "100%", "200%"])
      expect(hasHitBox(screen.getByRole("button", { name }))).toBe(true);
    expect(screen.getByRole("button", { name: "100%" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Fit" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Fit" }).getAttribute("title")).toBeTruthy();
  });

  it("pads the Assess toggle", () => {
    render(<AssessmentToggle />);
    expect(hasHitBox(screen.getByRole("button", { name: "Toggle colour assessment" }))).toBe(true);
  });

  it("pads the surround steppers and puts the small swatch inside a full-size button", () => {
    render(<SurroundControl />);
    expect(hasHitBox(screen.getByRole("button", { name: "Darker surround" }))).toBe(true);
    expect(hasHitBox(screen.getByRole("button", { name: "Lighter surround" }))).toBe(true);
    const swatch = screen.getByRole("button", { name: "Choose surround shade" });
    expect(hasHitBox(swatch)).toBe(true);
    expect(swatch.querySelector("span.h-3.w-3")).toBeTruthy();
  });
});
