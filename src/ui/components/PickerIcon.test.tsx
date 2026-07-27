// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Tests for the eyedropper glyph. It is decorative — the button that wraps it
// carries the label — so the contract is that it stays out of the a11y tree and
// inherits size and colour from its caller.

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PickerIcon } from "./PickerIcon.tsx";

function icon(container: HTMLElement): SVGSVGElement {
  const el = container.querySelector("svg");
  if (!el) throw new Error("no glyph rendered");
  return el;
}

describe("PickerIcon", () => {
  it("stays out of the accessibility tree", () => {
    const { container } = render(
      <button type="button">
        <PickerIcon />
        Sample
      </button>,
    );
    expect(icon(container).getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByRole("button").textContent).toBe("Sample");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("defaults to the 11px inline size and honours an override", () => {
    const { container, unmount } = render(<PickerIcon />);
    expect(icon(container).getAttribute("width")).toBe("11");
    expect(icon(container).getAttribute("height")).toBe("11");
    unmount();

    const large = render(<PickerIcon size={24} />);
    expect(icon(large.container).getAttribute("width")).toBe("24");
    expect(icon(large.container).getAttribute("height")).toBe("24");
  });

  it("scales its artwork rather than cropping it when resized", () => {
    const { container } = render(<PickerIcon size={24} />);
    expect(icon(container).getAttribute("viewBox")).toBe("0 0 24 24");
  });

  it("inherits its colour from the surrounding text", () => {
    const { container } = render(<PickerIcon />);
    expect(icon(container).getAttribute("stroke")).toBe("currentColor");
    expect(icon(container).getAttribute("fill")).toBe("none");
  });
});
