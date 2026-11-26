// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The status bar's zoom buttons are the stops picked in Preferences, as far in
// as the maximum zoom allows, after Fit.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { DEFAULT_SETTINGS, updateSettings } from "@/state/settings-store";
import { ZoomControls } from "./ZoomControls";

const names = () => screen.getAllByRole("button").map((b) => b.textContent);

afterEach(() => {
  updateSettings({
    developMaxZoom: DEFAULT_SETTINGS.developMaxZoom,
    developZoomStops: DEFAULT_SETTINGS.developZoomStops,
  });
});

describe("ZoomControls", () => {
  it("shows Fit and the default stops", () => {
    render(<ZoomControls zoom={null} onChange={() => {}} />);
    expect(names()).toEqual(["Fit", "25%", "50%", "100%", "150%", "200%"]);
  });

  it("shows the stops picked in Preferences", () => {
    updateSettings({ developZoomStops: [1, 4, 8] });
    render(<ZoomControls zoom={null} onChange={() => {}} />);
    expect(names()).toEqual(["Fit", "100%", "400%", "800%"]);
  });

  it("leaves out stops past the maximum zoom", () => {
    updateSettings({ developZoomStops: [1, 4, 16], developMaxZoom: 4 });
    render(<ZoomControls zoom={null} onChange={() => {}} />);
    expect(names()).toEqual(["Fit", "100%", "400%"]);
  });

  it("follows a change made while it is on screen", () => {
    render(<ZoomControls zoom={null} onChange={() => {}} />);
    act(() => updateSettings({ developZoomStops: [0.5, 8] }));
    expect(names()).toEqual(["Fit", "50%", "800%"]);
  });

  it("zooms to a stop and marks it", () => {
    updateSettings({ developZoomStops: [1, 8] });
    const onChange = vi.fn();
    render(<ZoomControls zoom={8} onChange={onChange} />);
    const eight = screen.getByRole("button", { name: "800%" });
    expect(eight.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "100%" }));
    expect(onChange).toHaveBeenLastCalledWith(1);
  });
});
