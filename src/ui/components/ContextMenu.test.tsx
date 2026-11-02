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

import { beforeAll, describe, it, expect, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { updateSettings } from "@/state/settings-store";
import { popEscapeHandler, pushEscapeHandler } from "@/ui/escape-stack";
import { ContextMenu, type ContextMenuEntry } from "./ContextMenu.tsx";

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

describe("ContextMenu keyboard", () => {
  const items = (onPick: (label: string) => void): ContextMenuEntry[] => [
    { label: "Open", onClick: () => onPick("Open") },
    { label: "Rename", disabled: true, onClick: () => onPick("Rename") },
    "separator",
    { label: "Rotate", onClick: () => onPick("Rotate") },
    { label: "Remove", onClick: () => onPick("Remove") },
  ];
  const item = (name: string) => screen.getByRole("menuitem", { name });

  function open(onPick = (_label: string) => {}) {
    render(<ContextMenu x={10} y={10} items={items(onPick)} onClose={() => {}} />);
  }

  it("moves focus to the first item on open", () => {
    open();
    expect(document.activeElement).toBe(item("Open"));
  });

  it("walks the enabled items with the arrow keys, wrapping at the ends", async () => {
    const user = userEvent.setup();
    open();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(item("Rotate"));
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(document.activeElement).toBe(item("Open"));
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(item("Remove"));
  });

  it("jumps to the first and last items with Home and End", async () => {
    const user = userEvent.setup();
    open();
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(item("Remove"));
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(item("Open"));
  });

  it("runs the focused item on Enter and on Space", async () => {
    const user = userEvent.setup();
    const picked: string[] = [];
    open((label) => picked.push(label));
    await user.keyboard("{ArrowDown}{Enter}");
    await user.keyboard("{ArrowDown} ");
    expect(picked).toEqual(["Rotate", "Remove"]);
  });

  it("hands focus back to where it was when it closes", () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const { unmount } = render(
      <ContextMenu x={10} y={10} items={items(() => {})} onClose={() => {}} />,
    );
    expect(document.activeElement).toBe(item("Open"));
    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});

describe("ContextMenu escape", () => {
  it("stays below a dialog opened after it, however often the menu re-renders", () => {
    const menuItems: ContextMenuEntry[] = [{ label: "Open", onClick: () => {} }];
    const first = vi.fn();
    const { rerender } = render(<ContextMenu x={0} y={0} items={menuItems} onClose={first} />);
    const dialog = vi.fn();
    const off = pushEscapeHandler(dialog);

    const second = vi.fn();
    rerender(<ContextMenu x={0} y={0} items={menuItems} onClose={second} />);
    popEscapeHandler();
    expect(dialog).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();

    off();
    popEscapeHandler();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });
});
