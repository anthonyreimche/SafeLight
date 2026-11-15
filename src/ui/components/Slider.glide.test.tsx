// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The fill glides to a value that arrived as a jump (reset, undo, preset) and
// follows live input exactly: a transition during a drag would lag the thumb.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useDevelopStore } from "@/state/develop-store";
import { noteDiscreteChange } from "@/ui/motion";
import { Slider } from "./Slider";

beforeEach(() => {
  useDevelopStore.setState({ photoId: "a" });
  // Far enough back that no earlier test's note counts as recent.
  noteDiscreteChange(Number.NEGATIVE_INFINITY);
});
afterEach(() => useDevelopStore.setState({ photoId: null }));

const fill = (container: HTMLElement) =>
  container.querySelector<HTMLElement>(".sl-slider-fill")!;
const thumb = (container: HTMLElement) =>
  container.querySelector<HTMLElement>(".sl-slider-thumb")!;

const element = (value: number, extra: { trackBackground?: string } = {}) => (
  <Slider
    label="Exposure"
    value={value}
    defaultValue={0}
    onChange={() => {}}
    onCommit={() => {}}
    {...extra}
  />
);

describe("Slider glide", () => {
  it("glides the fill and thumb after a discrete change", () => {
    const { container, rerender } = render(element(10));
    noteDiscreteChange();
    rerender(element(40));
    expect(fill(container).style.transition).toContain("width");
    expect(thumb(container).style.transition).toContain("left");
  });

  it("glides a coloured track's marker after a discrete change", () => {
    const { container, rerender } = render(element(10, { trackBackground: "red" }));
    noteDiscreteChange();
    rerender(element(40, { trackBackground: "red" }));
    const marker = container.querySelector<HTMLElement>(".sl-slider-marker")!;
    expect(marker.style.transition).toContain("left");
  });

  it("does not glide a live write", () => {
    const { container, rerender } = render(element(10));
    rerender(element(40));
    expect(fill(container).style.transition).toBe("");
  });

  it("does not glide when the value is unchanged", () => {
    const { container, rerender } = render(element(10));
    noteDiscreteChange();
    rerender(element(10));
    expect(fill(container).style.transition).toBe("");
  });

  it("does not glide during the slider's own drag", () => {
    const { container, rerender } = render(element(10));
    const input = screen.getByRole("slider", { name: "Exposure" });
    vi.spyOn(input, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 0, width: 200, height: 16 }),
    );
    fireEvent.pointerDown(input, { button: 0, clientX: 100, pointerId: 1 });
    noteDiscreteChange();
    rerender(element(40));
    expect(fill(container).style.transition).toBe("");
  });

  it("glides the slider's own double-click reset", () => {
    const { container, rerender } = render(element(40));
    const input = screen.getByRole("slider", { name: "Exposure" });
    fireEvent.doubleClick(input);
    rerender(element(0));
    expect(fill(container).style.transition).toContain("width");
  });

  it("glides the slider's own Escape revert", () => {
    const { container, rerender } = render(element(40));
    const field = screen.getByRole("textbox", { name: "Exposure value" });
    fireEvent.focus(field);
    rerender(element(55));
    fireEvent.keyDown(field, { key: "Escape" });
    rerender(element(40));
    expect(fill(container).style.transition).toContain("width");
  });

  // A held Ctrl+Z: the canvas cuts to each step after the first, and so does the fill.
  it("follows discrete changes that come in quick succession at once", () => {
    const { container, rerender } = render(element(10));
    noteDiscreteChange();
    rerender(element(40));
    expect(fill(container).style.transition).toContain("width");
    noteDiscreteChange();
    rerender(element(30));
    expect(fill(container).style.transition).toBe("");
  });

  // Inline "none" would beat a theme's or an extension's own transition on the parts.
  it("leaves the parts' transition to the stylesheet when not gliding", () => {
    const { container } = render(element(10));
    expect(fill(container).style.transition).toBe("");
    expect(thumb(container).style.transition).toBe("");
    const coloured = render(element(10, { trackBackground: "red" })).container;
    expect(coloured.querySelector<HTMLElement>(".sl-slider-marker")!.style.transition).toBe("");
  });

  it("stops gliding on the next live change", () => {
    const { container, rerender } = render(element(10));
    noteDiscreteChange();
    rerender(element(40));
    noteDiscreteChange(Number.NEGATIVE_INFINITY);
    rerender(element(41));
    expect(fill(container).style.transition).toBe("");
  });
});
