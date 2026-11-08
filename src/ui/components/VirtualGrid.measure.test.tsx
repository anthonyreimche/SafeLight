// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The grid measures its container before the first paint, so it never shows a
// single zero-width column while it waits for a ResizeObserver callback. The
// stubbed observer never reports, which is the gap the synchronous read closes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { VirtualGrid } from "./VirtualGrid";

class SilentObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", SilentObserver);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const items = Array.from({ length: 50 }, (_, i) => i);

describe("VirtualGrid first frame", () => {
  it("reports the measured column count and never a placeholder 1", () => {
    const onColumnsChange = vi.fn();
    render(
      <VirtualGrid
        items={items}
        cellWidth={100}
        cellHeight={100}
        renderCell={(i) => <span>{i}</span>}
        getKey={String}
        onColumnsChange={onColumnsChange}
      />,
    );
    expect(onColumnsChange.mock.calls.map(([c]) => c)).toEqual([10]);
  });

  it("lays the first committed cells out in the measured columns", () => {
    const view = render(
      <VirtualGrid
        items={items}
        cellWidth={100}
        cellHeight={100}
        renderCell={(i) => <span>{i}</span>}
        getKey={String}
      />,
    );
    const cell = (n: number) =>
      view.getByText(String(n)).parentElement as HTMLElement;
    expect(cell(1).style.left).toBe("100px");
    expect(cell(1).style.width).toBe("100px");
    expect(cell(10).style.top).toBe("100px");
  });
});
