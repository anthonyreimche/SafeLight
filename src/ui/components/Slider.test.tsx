// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The Develop slider's styling hooks: the `sl-slider-*` classes an
// input-styling extension targets, and the knob element that exists only so
// such a stylesheet can show it (index.css hides it by default). Drag/scrub
// behaviour is pointer-geometry driven and stays manually verified.

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
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
