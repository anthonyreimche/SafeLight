// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Tab wrapping for modal surfaces (ModalWindow, the welcome setup). jsdom has
// no layout, and the trap skips tab stops that aren't laid out, so these tests
// pretend everything is on screen unless they're testing exactly that.

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { trapTab } from "./focus-trap";

afterEach(() => vi.restoreAllMocks());

const layOutEverything = () =>
  vi
    .spyOn(Element.prototype, "getClientRects")
    .mockReturnValue([{} as DOMRect] as unknown as DOMRectList);

function Trapped() {
  return (
    <div
      data-testid="box"
      tabIndex={-1}
      onKeyDown={(e) => trapTab(e, e.currentTarget)}
    >
      <button type="button">First</button>
      <button type="button" disabled>
        Off
      </button>
      <button type="button">Last</button>
    </div>
  );
}

/** A focusable heading that isn't a tab stop, as the welcome setup's step
 *  heading is, among four buttons. */
function WithHeading({ at }: { at: "start" | "middle" }) {
  const heading = <h1 tabIndex={-1}>Step</h1>;
  return (
    <div tabIndex={-1} onKeyDown={(e) => trapTab(e, e.currentTarget)}>
      {at === "start" && heading}
      <button type="button">One</button>
      <button type="button">Two</button>
      {at === "middle" && heading}
      <button type="button">Three</button>
      <button type="button">Four</button>
    </div>
  );
}

const button = (name: string) => screen.getByRole("button", { name });
const heading = () => screen.getByRole("heading", { name: "Step" });

describe("trapTab", () => {
  it("wraps Tab from the last tab stop to the first", () => {
    layOutEverything();
    render(<Trapped />);
    button("Last").focus();
    fireEvent.keyDown(button("Last"), { key: "Tab" });
    expect(document.activeElement).toBe(button("First"));
  });

  it("wraps Shift+Tab from the first tab stop to the last", () => {
    layOutEverything();
    render(<Trapped />);
    button("First").focus();
    fireEvent.keyDown(button("First"), { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(button("Last"));
  });

  it("wraps Shift+Tab from the container itself to the last", () => {
    layOutEverything();
    render(<Trapped />);
    const box = screen.getByTestId("box");
    box.focus();
    fireEvent.keyDown(box, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(button("Last"));
  });

  it("leaves other keys alone", () => {
    layOutEverything();
    render(<Trapped />);
    button("Last").focus();
    fireEvent.keyDown(button("Last"), { key: "Enter" });
    expect(document.activeElement).toBe(button("Last"));
  });

  it("holds focus where it is when no tab stop is laid out", () => {
    render(<Trapped />);
    button("Last").focus();
    const notPrevented = fireEvent.keyDown(button("Last"), { key: "Tab" });
    expect(notPrevented).toBe(false);
    expect(document.activeElement).toBe(button("Last"));
  });

  it("moves Tab from a heading to the tab stop after it", () => {
    layOutEverything();
    render(<WithHeading at="middle" />);
    heading().focus();
    const notPrevented = fireEvent.keyDown(heading(), { key: "Tab" });
    expect(notPrevented).toBe(false);
    expect(document.activeElement).toBe(button("Three"));
  });

  it("moves Shift+Tab from a heading to the tab stop before it", () => {
    layOutEverything();
    render(<WithHeading at="middle" />);
    heading().focus();
    fireEvent.keyDown(heading(), { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(button("Two"));
  });

  it("wraps Shift+Tab from a heading before every tab stop to the last", () => {
    layOutEverything();
    render(<WithHeading at="start" />);
    heading().focus();
    fireEvent.keyDown(heading(), { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(button("Four"));
  });
});
