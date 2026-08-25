// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// ContextMenu receives the cursor as client (visual-px) coordinates but
// positions itself through CSS left/top, which the <body> UI-scale zoom
// renders in layout px (see frame-point.ts) — at scale ≠ 100% the two spaces
// differ by uiScale, which anchored the menu far from the pointer and broke
// the bottom-edge clamp (issue #103). jsdom has no layout engine, so the
// menu's measured size is stubbed here where the expected numbers are visible.

import { beforeAll, describe, it, expect, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { updateSettings } from "@/state/settings-store";
import { ContextMenu } from "./ContextMenu.tsx";

const size = { width: 0, height: 0 };

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

function renderMenu(x: number, y: number, w = 200, h = 120): HTMLElement {
  size.width = w;
  size.height = h;
  render(
    <ContextMenu x={x} y={y} items={[{ label: "Open", onClick: () => {} }]} onClose={() => {}} />,
  );
  return screen.getByRole("menu");
}

// The jsdom viewport is 1024×768.
describe("ContextMenu placement", () => {
  it("anchors at the cursor when the menu fits", () => {
    const menu = renderMenu(300, 200);
    expect([menu.style.left, menu.style.top]).toEqual(["300px", "200px"]);
  });

  it("clamps to the right and bottom viewport edges", () => {
    const menu = renderMenu(1000, 700);
    expect([menu.style.left, menu.style.top]).toEqual(["820px", "644px"]);
  });

  it("maps client coordinates into layout px under the UI-scale zoom", () => {
    updateSettings({ uiScale: 1.25 });
    const menu = renderMenu(500, 400);
    expect([menu.style.left, menu.style.top]).toEqual(["400px", "320px"]);
  });

  it("keeps the zoomed menu inside the viewport near the bottom edge", () => {
    updateSettings({ uiScale: 2 });
    // Layout viewport at 200% is 512×384: clamp to 512−200−4 and 384−120−4.
    const menu = renderMenu(1000, 700);
    expect([menu.style.left, menu.style.top]).toEqual(["308px", "260px"]);
  });

  it("pins to the viewport origin when the menu cannot fit", () => {
    const menu = renderMenu(100, 100, 200, 900);
    expect(menu.style.top).toBe("0px");
  });
});
