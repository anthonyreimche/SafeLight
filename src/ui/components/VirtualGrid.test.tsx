// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Scrolling fires far more events than it crosses rows. The grid should redraw
// its cells when the set of visible rows changes, not on every scroll event.
// jsdom has no layout, so the container's size comes from a stubbed observer and
// the scroll position is set by hand.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { VirtualGrid } from "./VirtualGrid";

const VIEW = { w: 1000, h: 600 };
const CELL = 100;
const COLUMNS = 10;
const OVERSCAN = 2;
const ITEMS = Array.from({ length: 10_000 }, (_, i) => i);

class FixedObserver {
  private readonly cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(): void {
    this.cb([{ contentRect: { width: VIEW.w, height: VIEW.h } }] as never, this as never);
  }
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(() => vi.stubGlobal("ResizeObserver", FixedObserver));
afterAll(() => vi.unstubAllGlobals());

describe("VirtualGrid scrolling", () => {
  it("redraws its cells only when the visible rows change", () => {
    // Row 7 is on screen for the whole 800px scroll below, so each call for its
    // first cell is one redraw pass over the grid.
    const probe = 7 * COLUMNS;
    const calls = { all: 0, probe: 0 };
    const renderCell = (item: number) => {
      calls.all++;
      if (item === probe) calls.probe++;
      return <span>{item}</span>;
    };
    const view = render(
      <VirtualGrid
        items={ITEMS}
        cellWidth={CELL}
        cellHeight={CELL}
        overscan={OVERSCAN}
        renderCell={renderCell}
        getKey={String}
      />,
    );
    const scroller = view.container.firstElementChild as HTMLElement;
    calls.all = 0;
    calls.probe = 0;

    const steps = 100;
    const stepPx = 8;
    for (let i = 1; i <= steps; i++) {
      scroller.scrollTop = i * stepPx;
      act(() => void fireEvent.scroll(scroller));
    }

    // Each row boundary crossed moves the first row once and the last row once.
    const rowsCrossed = (steps * stepPx) / CELL;
    expect(calls.probe).toBeLessThanOrEqual(2 * rowsCrossed);
    const rowsPerPass = VIEW.h / CELL + 1 + 2 * OVERSCAN;
    expect(calls.all).toBeLessThanOrEqual(2 * rowsCrossed * rowsPerPass * COLUMNS);
  });
});

describe("VirtualGrid semantics", () => {
  it("is a labelled multi-select listbox whose positioning wrappers are transparent", () => {
    const view = render(
      <VirtualGrid
        items={[1, 2]}
        cellWidth={CELL}
        cellHeight={CELL}
        renderCell={(i) => <span role="option" aria-selected={false}>{i}</span>}
        getKey={String}
        role="listbox"
        aria-label="Photos"
      />,
    );
    const box = view.getByRole("listbox", { name: "Photos" });
    expect(box.getAttribute("aria-multiselectable")).toBe("true");
    expect(view.getAllByRole("option")).toHaveLength(2);
  });
});
