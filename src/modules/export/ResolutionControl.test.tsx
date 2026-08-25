// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The Resolution control offers the four preset long edges plus a free custom
// pixel value. The custom input commits on blur/Enter, clamps to the supported
// range, reverts invalid entries, and re-derives which mode is selected when
// the value changes from outside (export-preset load, settings seed).

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  ResolutionControl,
  parseLongEdge,
  isPresetLongEdge,
  MIN_LONG_EDGE,
  MAX_LONG_EDGE,
} from "./ResolutionControl.tsx";

describe("parseLongEdge", () => {
  it("parses and rounds positive numbers", () => {
    expect(parseLongEdge("3000")).toBe(3000);
    expect(parseLongEdge("2048.6")).toBe(2049);
    expect(parseLongEdge(" 1500 ")).toBe(1500);
  });

  it("clamps to the supported range", () => {
    expect(parseLongEdge("5")).toBe(MIN_LONG_EDGE);
    expect(parseLongEdge("999999")).toBe(MAX_LONG_EDGE);
  });

  it("rejects empty and non-positive input", () => {
    expect(parseLongEdge("")).toBeNull();
    expect(parseLongEdge("abc")).toBeNull();
    expect(parseLongEdge("0")).toBeNull();
    expect(parseLongEdge("-500")).toBeNull();
  });
});

describe("isPresetLongEdge", () => {
  it("recognises the built-in options", () => {
    expect(isPresetLongEdge(null)).toBe(true);
    expect(isPresetLongEdge(4096)).toBe(true);
    expect(isPresetLongEdge(2048)).toBe(true);
    expect(isPresetLongEdge(1024)).toBe(true);
    expect(isPresetLongEdge(3000)).toBe(false);
  });
});

function renderControl(value: number | null) {
  const onChange = vi.fn();
  render(<ResolutionControl variant="panel" value={value} onChange={onChange} />);
  return onChange;
}

const chip = (name: string) => screen.getByRole("button", { name });
const input = () =>
  screen.getByRole("spinbutton", { name: /custom long edge/i }) as HTMLInputElement;
const pressed = (name: string) => chip(name).getAttribute("aria-pressed");

describe("ResolutionControl", () => {
  it("marks the matching preset as selected", () => {
    renderControl(2048);
    expect(pressed("2048 px")).toBe("true");
    expect(pressed("Custom")).toBe("false");
  });

  it("starts in custom mode when the value is not a preset", () => {
    renderControl(3000);
    expect(pressed("Custom")).toBe("true");
    expect(input().value).toBe("3000");
  });

  it("selects presets and reports them", () => {
    const onChange = renderControl(2048);
    fireEvent.click(chip("1024 px"));
    expect(onChange).toHaveBeenCalledWith(1024);
    fireEvent.click(chip("Original"));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("switches to custom mode seeded from the current value", () => {
    const onChange = renderControl(2048);
    fireEvent.click(chip("Custom"));
    expect(pressed("Custom")).toBe("true");
    expect(input().value).toBe("2048");
    expect(document.activeElement).toBe(input());
    // Same pixel value as before — no spurious change report.
    expect(onChange).not.toHaveBeenCalled();
  });

  it("commits the seeded custom value when coming from Original", () => {
    const onChange = renderControl(null);
    fireEvent.click(chip("Custom"));
    expect(onChange).toHaveBeenCalledWith(2048);
  });

  it("activates custom mode on typing and commits on blur", () => {
    const onChange = renderControl(1024);
    fireEvent.change(input(), { target: { value: "2500" } });
    expect(pressed("Custom")).toBe("true");
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(input());
    expect(onChange).toHaveBeenCalledWith(2500);
  });

  it("commits on Enter", () => {
    const onChange = renderControl(1024);
    fireEvent.change(input(), { target: { value: "1500" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(1500);
  });

  it("clamps committed values and normalises the field", () => {
    const onChange = renderControl(1024);
    fireEvent.change(input(), { target: { value: "5" } });
    fireEvent.blur(input());
    expect(onChange).toHaveBeenCalledWith(MIN_LONG_EDGE);
    expect(input().value).toBe(String(MIN_LONG_EDGE));
  });

  it("reverts invalid input on blur without reporting a change", () => {
    const onChange = renderControl(3000);
    fireEvent.change(input(), { target: { value: "" } });
    fireEvent.blur(input());
    expect(onChange).not.toHaveBeenCalled();
    expect(input().value).toBe("3000");
    expect(pressed("Custom")).toBe("true");
  });

  it("does nothing on focus and blur alone", () => {
    const onChange = renderControl(null);
    fireEvent.focus(input());
    fireEvent.blur(input());
    expect(onChange).not.toHaveBeenCalled();
    expect(pressed("Original")).toBe("true");
  });

  it("re-derives its mode when the value changes from outside", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ResolutionControl variant="panel" value={3000} onChange={onChange} />,
    );
    rerender(<ResolutionControl variant="panel" value={1024} onChange={onChange} />);
    expect(pressed("1024 px")).toBe("true");
    expect(pressed("Custom")).toBe("false");
    rerender(<ResolutionControl variant="panel" value={5000} onChange={onChange} />);
    expect(pressed("Custom")).toBe("true");
    expect(input().value).toBe("5000");
  });

  it("renders the preferences variant with the same controls", () => {
    render(
      <ResolutionControl variant="preferences" value={2048} onChange={() => {}} />,
    );
    expect(pressed("2048 px")).toBe("true");
    expect(input()).toBeTruthy();
  });
});
