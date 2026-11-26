// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Preferences ▸ Performance sets how far Develop zooms and which zooms the
// status bar offers; a zoom past the maximum can't be picked as a button.

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { DEFAULT_SETTINGS, getSettings, updateSettings } from "@/state/settings-store";

vi.mock("@/diagnostics/environment", () => ({ readWebGLInfo: () => null }));

const { PerformanceSection } = await import("./Performance");

afterEach(() => {
  updateSettings({
    developMaxZoom: DEFAULT_SETTINGS.developMaxZoom,
    developZoomStops: DEFAULT_SETTINGS.developZoomStops,
  });
});

const field = (label: string) => screen.getByText(label).parentElement as HTMLElement;

describe("Develop zoom preferences", () => {
  it("sets the maximum zoom", () => {
    render(<PerformanceSection />);
    const max = within(field("Maximum zoom"));
    expect(max.getByRole("button", { name: "800%" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(max.getByRole("button", { name: "1600%" }));
    expect(getSettings().developMaxZoom).toBe(16);
  });

  it("turns zoom buttons on and off, keeping their order", () => {
    render(<PerformanceSection />);
    const stops = within(field("Zoom buttons"));
    fireEvent.click(stops.getByRole("button", { name: "800%" }));
    fireEvent.click(stops.getByRole("button", { name: "50%" }));
    fireEvent.click(stops.getByRole("button", { name: "400%" }));
    expect(getSettings().developZoomStops).toEqual([0.25, 1, 1.5, 2, 4, 8]);
  });

  it("can't pick a zoom button past the maximum", () => {
    updateSettings({ developMaxZoom: 4 });
    render(<PerformanceSection />);
    const stops = within(field("Zoom buttons"));
    expect((stops.getByRole("button", { name: "800%" }) as HTMLButtonElement).disabled).toBe(true);
    expect((stops.getByRole("button", { name: "400%" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
