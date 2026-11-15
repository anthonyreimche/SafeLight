// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The Develop slider's styling hooks: the `sl-slider-*` classes an
// input-styling extension targets, and the knob element that exists only so
// such a stylesheet can show it (index.css hides it by default). Drag/scrub
// behaviour is pointer-geometry driven and stays manually verified. Then the
// typed value field (select on focus, Enter keeps, Escape reverts) and
// Shift+wheel stepping.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { useDevelopStore } from "@/state/develop-store";
import { Slider } from "./Slider.tsx";

const noop = () => {};
const at25 = { value: 25, min: -100, max: 100 }; // 62.5% along the track

describe("Slider styling hooks", () => {
  it("exposes wrapper, label, track, fill, thumb and value hooks", () => {
    const { container } = render(<Slider label="Exposure" {...at25} onChange={noop} />);
    expect(container.querySelector("label.sl-slider-label")?.textContent).toBe("Exposure");
    const wrap = container.querySelector(".sl-slider-wrap");
    expect(wrap?.querySelector(".sl-slider-track > .sl-slider-fill")).not.toBeNull();
    expect(wrap?.querySelector(".sl-slider-thumb")).not.toBeNull();
    expect(container.querySelector("input.sl-slider-value")).not.toBeNull();
  });

  it("places the thumb at the value, matching the fill", () => {
    const { container } = render(<Slider label="Exposure" {...at25} onChange={noop} />);
    const fill = container.querySelector<HTMLElement>(".sl-slider-fill")!;
    const thumb = container.querySelector<HTMLElement>(".sl-slider-thumb")!;
    expect(fill.style.width).toBe("62.5%");
    expect(thumb.style.left).toBe("62.5%");
    expect(thumb.getAttribute("aria-hidden")).toBe("true");
  });

  it("renders the marker instead of the thumb on a gradient track", () => {
    const { container } = render(
      <Slider
        label="Hue"
        {...at25}
        trackBackground="linear-gradient(to right, red, blue)"
        onChange={noop}
      />,
    );
    expect(container.querySelector(".sl-slider-track")).not.toBeNull();
    expect(container.querySelector<HTMLElement>(".sl-slider-marker")?.style.left).toBe("62.5%");
    expect(container.querySelector(".sl-slider-thumb")).toBeNull();
  });

  it("omits the value field with hideValue", () => {
    const { container } = render(<Slider label="Amount" {...at25} hideValue onChange={noop} />);
    expect(container.querySelector(".sl-slider-value")).toBeNull();
  });
});

/** A slider over real state, recording its changes and commits. */
function Harness({
  initial,
  step,
  min,
  max,
  onChange,
  onCommit,
}: {
  initial: number;
  step?: number;
  min?: number;
  max?: number;
  onChange: (v: number) => void;
  onCommit: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <Slider
      label="Exposure"
      value={value}
      step={step}
      min={min}
      max={max}
      onChange={(v) => {
        setValue(v);
        onChange(v);
      }}
      onCommit={onCommit}
    />
  );
}

const field = () => screen.getByRole("textbox", { name: "Exposure value" }) as HTMLInputElement;

describe("the typed value", () => {
  it("selects the whole value on focus, so typing replaces it", () => {
    render(<Harness initial={25} onChange={noop} onCommit={noop} />);
    act(() => field().focus());
    expect(field().value).toBe("25");
    expect([field().selectionStart, field().selectionEnd]).toEqual([0, 2]);
  });

  it("keeps the typed value and leaves the field on Enter", () => {
    const onCommit = vi.fn();
    const onChange = vi.fn();
    render(<Harness initial={25} onChange={onChange} onCommit={onCommit} />);
    act(() => field().focus());
    fireEvent.change(field(), { target: { value: "40" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(document.activeElement).not.toBe(field());
    expect(onChange).toHaveBeenLastCalledWith(40);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(field().value).toBe("+40");
  });

  it("reads a decimal comma as the decimal separator", () => {
    const onChange = vi.fn();
    render(<Harness initial={25} onChange={onChange} onCommit={noop} />);
    act(() => field().focus());
    fireEvent.change(field(), { target: { value: "1,5" } });
    fireEvent.blur(field());
    expect(onChange).toHaveBeenLastCalledWith(1.5);
  });

  it("puts the value back and commits nothing on Escape", () => {
    const onCommit = vi.fn();
    const onChange = vi.fn();
    render(<Harness initial={25} onChange={onChange} onCommit={onCommit} />);
    act(() => field().focus());
    fireEvent.change(field(), { target: { value: "40" } });
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(document.activeElement).not.toBe(field());
    expect(onChange).toHaveBeenLastCalledWith(25);
    expect(onCommit).not.toHaveBeenCalled();
    expect(field().value).toBe("+25");
  });
});

describe("Shift+wheel over the slider", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const track = () => screen.getByRole("slider", { name: "Exposure" }).parentElement!;

  it("steps a hundredth of the range per notch, up raising the value", () => {
    const onChange = vi.fn();
    render(<Harness initial={25} onChange={onChange} onCommit={noop} />);
    fireEvent.wheel(track(), { deltaY: -100, shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(27);
    fireEvent.wheel(track(), { deltaY: 100, shiftKey: true });
    fireEvent.wheel(track(), { deltaY: 100, shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(23);
  });

  it("reads the horizontal delta some systems turn Shift+wheel into", () => {
    const onChange = vi.fn();
    render(<Harness initial={25} onChange={onChange} onCommit={noop} />);
    fireEvent.wheel(track(), { deltaX: -100, deltaY: 0, shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(27);
  });

  it("snaps to the slider's step and stops at its ends", () => {
    const onChange = vi.fn();
    render(<Harness initial={4.98} min={-5} max={5} step={0.01} onChange={onChange} onCommit={noop} />);
    fireEvent.wheel(track(), { deltaY: -100, shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(5);
    fireEvent.wheel(track(), { deltaY: 100, shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(4.9);
  });

  it("commits once after the notches settle", () => {
    const onCommit = vi.fn();
    render(<Harness initial={25} onChange={noop} onCommit={onCommit} />);
    fireEvent.wheel(track(), { deltaY: -100, shiftKey: true });
    fireEvent.wheel(track(), { deltaY: -100, shiftKey: true });
    expect(onCommit).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(500));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("drops its waiting commit when Develop moves to another photo", () => {
    useDevelopStore.setState({ photoId: "a" });
    const onCommit = vi.fn();
    render(<Harness initial={25} onChange={noop} onCommit={onCommit} />);
    fireEvent.wheel(track(), { deltaY: -100, shiftKey: true });

    act(() => useDevelopStore.setState({ photoId: "b" }));
    act(() => vi.advanceTimersByTime(500));

    expect(onCommit).not.toHaveBeenCalled();
    useDevelopStore.setState({ photoId: null });
  });

  it("leaves a plain wheel to scroll the panel", () => {
    const onChange = vi.fn();
    render(<Harness initial={25} onChange={onChange} onCommit={noop} />);
    const plain = fireEvent.wheel(track(), { deltaY: -100 });
    expect(plain).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    expect(fireEvent.wheel(track(), { deltaY: -100, shiftKey: true })).toBe(false);
  });
});

describe("a drag when Develop moves to another photo", () => {
  afterEach(() => useDevelopStore.setState({ photoId: null }));

  /** The range input over a 200 px track, so 1 px is one unit of -100..100. */
  const rangeInput = () => {
    const input = screen.getByRole("slider", { name: "Exposure" });
    vi.spyOn(input, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 0, width: 200, height: 16 }),
    );
    return input;
  };

  it("drags and commits on the photo it started on", () => {
    useDevelopStore.setState({ photoId: "a" });
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(<Harness initial={25} onChange={onChange} onCommit={onCommit} />);
    const input = rangeInput();

    fireEvent.pointerDown(input, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(input, { clientX: 110, pointerId: 1 });
    fireEvent.pointerUp(input, { pointerId: 1 });

    expect(onChange).toHaveBeenLastCalledWith(35);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("hands the next photo nothing from a drag begun on the last one", () => {
    useDevelopStore.setState({ photoId: "a" });
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(<Harness initial={25} onChange={onChange} onCommit={onCommit} />);
    const input = rangeInput();

    fireEvent.pointerDown(input, { button: 0, clientX: 100, pointerId: 1 });
    act(() => useDevelopStore.setState({ photoId: "b" }));
    fireEvent.pointerMove(input, { clientX: 110, pointerId: 1 });
    fireEvent.pointerUp(input, { pointerId: 1 });

    expect(onChange).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });
});

// Shift+double-click sets the one value automatically when the caller gives
// onAuto; a plain double-click still resets.
describe("Slider auto", () => {
  const track = () => screen.getByRole("slider", { name: "Exposure" });

  it("calls onAuto on Shift+double-click, and neither resets nor commits", () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    const onAuto = vi.fn();
    render(<Slider label="Exposure" {...at25} onChange={onChange} onCommit={onCommit} onAuto={onAuto} />);
    fireEvent.doubleClick(track(), { shiftKey: true });
    expect(onAuto).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("still resets on a double-click without Shift", () => {
    const onChange = vi.fn();
    const onAuto = vi.fn();
    render(<Slider label="Exposure" {...at25} defaultValue={0} onChange={onChange} onAuto={onAuto} />);
    fireEvent.doubleClick(track());
    expect(onChange).toHaveBeenCalledWith(0);
    expect(onAuto).not.toHaveBeenCalled();
  });

  it("resets on Shift+double-click when there is no onAuto", () => {
    const onChange = vi.fn();
    render(<Slider label="Exposure" {...at25} defaultValue={0} onChange={onChange} />);
    fireEvent.doubleClick(track(), { shiftKey: true });
    expect(onChange).toHaveBeenCalledWith(0);
  });

  it("names the gesture in the track's tooltip only when it is offered", () => {
    const { rerender } = render(<Slider label="Exposure" {...at25} onChange={noop} />);
    expect(track().getAttribute("title")).not.toContain("Shift+double-click");
    rerender(<Slider label="Exposure" {...at25} onChange={noop} onAuto={noop} />);
    expect(track().getAttribute("title")).toContain("Shift+double-click for auto");
  });

  it("calls the latest onAuto after a re-render", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Slider label="Exposure" {...at25} onChange={noop} onAuto={first} />);
    rerender(<Slider label="Exposure" {...at25} onChange={noop} onAuto={second} />);
    fireEvent.doubleClick(track(), { shiftKey: true });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
