// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// PresetTooltip measures the hovered row via getBoundingClientRect — client
// (visual) px — but positions its <body> portal through CSS left/top, which
// the <body> UI-scale zoom renders in layout px (see frame-point.ts). At
// scale ≠ 100% the two spaces differ by uiScale, and the error grows with the
// anchor's absolute x — so a right-docked info panel pushed the tooltip past
// the window's right edge (issue #105). jsdom has no layout engine, so the
// anchor rect and the tooltip's measured size are stubbed here.

import { beforeAll, describe, it, expect, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { updateSettings } from "@/state/settings-store";
import { PresetTooltip } from "./PresetTooltip.tsx";

const size = { width: 192, height: 120 };

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => size.width,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => size.height,
  });
});

afterEach(() => updateSettings({ uiScale: 1 }));

function anchorAt(rect: { left: number; top: number; right: number; bottom: number }): HTMLElement {
  const el = document.createElement("div");
  el.getBoundingClientRect = () =>
    ({
      ...rect,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({}),
    }) as DOMRect;
  return el;
}

function renderTooltip(rect: {
  left: number;
  top: number;
  right: number;
  bottom: number;
}): HTMLElement {
  render(
    <PresetTooltip
      name="Novachrome"
      diffs={[{ label: "Contrast", value: "+20" }]}
      anchor={anchorAt(rect)}
    />,
  );
  return screen.getByRole("tooltip");
}

// The jsdom viewport is 1024×768; the stubbed tooltip measures 192×120.
describe("PresetTooltip placement", () => {
  it("lists the preset name and its adjustments", () => {
    const tip = renderTooltip({ left: 100, top: 200, right: 300, bottom: 220 });
    expect(tip.textContent).toContain("Novachrome");
    expect(tip.textContent).toContain("Contrast");
  });

  it("opens to the right of the hovered row when there is room", () => {
    const tip = renderTooltip({ left: 100, top: 200, right: 300, bottom: 220 });
    expect([tip.style.left, tip.style.top]).toEqual(["308px", "200px"]);
  });

  it("flips to the left of the row when the right side would overflow", () => {
    const tip = renderTooltip({ left: 700, top: 200, right: 1010, bottom: 220 });
    expect([tip.style.left, tip.style.top]).toEqual(["500px", "200px"]);
  });

  it("maps the anchor rect into layout px under the UI-scale zoom", () => {
    updateSettings({ uiScale: 1.25 });
    // Layout-px anchor is 400/1.25 → right 320; right side fits in 1024/1.25.
    const tip = renderTooltip({ left: 200, top: 250, right: 400, bottom: 270 });
    expect([tip.style.left, tip.style.top]).toEqual(["328px", "200px"]);
  });

  it("stays inside the window for a right-docked panel under the zoom", () => {
    updateSettings({ uiScale: 1.25 });
    // Issue #105: layout viewport is 819.2 wide; the row spans 720–808 in
    // layout px, so the tooltip must flip left of it and stay fully on-screen.
    const tip = renderTooltip({ left: 900, top: 300, right: 1010, bottom: 320 });
    expect([tip.style.left, tip.style.top]).toEqual(["520px", "240px"]);
  });

  it("clamps to the viewport edge when neither side fits", () => {
    const tip = renderTooltip({ left: 50, top: 200, right: 900, bottom: 220 });
    expect(tip.style.left).toBe("8px");
  });

  it("clamps to the bottom edge in layout px under the UI-scale zoom", () => {
    updateSettings({ uiScale: 2 });
    // Layout viewport at 200% is 512×384: top clamps to 384 − 120 − 8.
    const tip = renderTooltip({ left: 100, top: 700, right: 300, bottom: 720 });
    expect([tip.style.left, tip.style.top]).toEqual(["158px", "256px"]);
  });
});
