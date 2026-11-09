// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A panel that subscribes to every param re-renders all its sliders on each
// tick of one of them. The slider body should only render when something it
// shows changes, yet always call the callbacks of the latest render: callers
// pass inline closures bound to a mask or key, so a stale one writes to the
// wrong place.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useDevelopStore } from "@/state/develop-store";

const renders = vi.hoisted(() => ({ n: 0 }));

// The settings hook runs once per render of the slider body.
vi.mock("@/state/settings-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/settings-store")>();
  const useSettings = ((select: Parameters<typeof actual.useSettings>[0]) => {
    renders.n++;
    return actual.useSettings(select);
  }) as typeof actual.useSettings;
  return { ...actual, useSettings: Object.assign(useSettings, actual.useSettings) };
});

import { Slider } from "./Slider.tsx";

beforeEach(() => {
  useDevelopStore.setState({ photoId: "a" });
});
afterEach(() => useDevelopStore.setState({ photoId: null }));

function Panel({ values }: { values: number[] }) {
  return (
    <>
      {values.map((v, i) => (
        <Slider key={i} label={`S${i}`} value={v} onChange={() => {}} onCommit={() => {}} />
      ))}
    </>
  );
}

describe("Slider re-renders", () => {
  it("renders only the slider whose value changed over ten ticks", () => {
    const base = Array.from({ length: 19 }, () => 0);
    const view = render(<Panel values={base} />);
    renders.n = 0;
    for (let tick = 1; tick <= 10; tick++) {
      const next = base.slice();
      next[3] = tick;
      view.rerender(<Panel values={next} />);
    }
    expect(renders.n).toBeLessThanOrEqual(10);
  });
});

describe("Slider callbacks after a re-render with new closures", () => {
  const range = () => {
    const input = screen.getByRole("slider", { name: "Exposure" });
    vi.spyOn(input, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 0, width: 200, height: 16 }),
    );
    return input;
  };
  const mount = (onChange: () => void, onCommit: () => void) => (
    <Slider label="Exposure" value={25} onChange={onChange} onCommit={onCommit} />
  );

  it("calls the newest onChange and onCommit for keyboard changes", () => {
    const oldChange = vi.fn();
    const oldCommit = vi.fn();
    const newChange = vi.fn();
    const newCommit = vi.fn();
    const view = render(mount(oldChange, oldCommit));
    view.rerender(mount(newChange, newCommit));

    const input = range();
    fireEvent.change(input, { target: { value: "30" } });
    fireEvent.keyUp(input, { key: "ArrowRight" });

    expect(newChange).toHaveBeenCalledWith(30);
    expect(newCommit).toHaveBeenCalledTimes(1);
    expect(oldChange).not.toHaveBeenCalled();
    expect(oldCommit).not.toHaveBeenCalled();
  });

  it("calls the newest callbacks when swapped in the middle of a drag", () => {
    const oldChange = vi.fn();
    const oldCommit = vi.fn();
    const newChange = vi.fn();
    const newCommit = vi.fn();
    const view = render(mount(oldChange, oldCommit));
    const input = range();

    fireEvent.pointerDown(input, { button: 0, clientX: 100, pointerId: 1 });
    view.rerender(mount(newChange, newCommit));
    fireEvent.pointerMove(input, { clientX: 110, pointerId: 1 });
    fireEvent.pointerUp(input, { pointerId: 1 });

    expect(newChange).toHaveBeenLastCalledWith(35);
    expect(newCommit).toHaveBeenCalledTimes(1);
    expect(oldChange).not.toHaveBeenCalled();
    expect(oldCommit).not.toHaveBeenCalled();
  });

  it("calls the newest onChange for Shift+wheel and the newest onModifierPreview", () => {
    const oldChange = vi.fn();
    const newChange = vi.fn();
    const oldPreview = vi.fn();
    const newPreview = vi.fn();
    const element = (change: () => void, preview: () => void) => (
      <Slider label="Exposure" value={25} onChange={change} onModifierPreview={preview} />
    );
    const view = render(element(oldChange, oldPreview));
    view.rerender(element(newChange, newPreview));

    const input = range();
    act(() => {
      fireEvent.wheel(input, { deltaY: -100, shiftKey: true });
    });
    fireEvent.pointerDown(input, { button: 0, clientX: 100, pointerId: 1, altKey: true });
    fireEvent.pointerUp(input, { pointerId: 1 });

    expect(newChange).toHaveBeenCalled();
    expect(newPreview).toHaveBeenCalledWith(true);
    expect(oldChange).not.toHaveBeenCalled();
    expect(oldPreview).not.toHaveBeenCalled();
  });
});
