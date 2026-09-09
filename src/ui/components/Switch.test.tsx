// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The one toggle switch used by Preferences, extension settings, the
// Extensions manager and api.ui.Toggle. Pins the accessible contract and the
// `sl-switch*` styling hooks that input-styling extensions target.

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Switch } from "./Switch.tsx";

describe("Switch", () => {
  it("is a switch button that reflects the checked state", () => {
    render(<Switch checked ariaLabel="Larger text" onChange={() => {}} />);
    const sw = screen.getByRole("switch", { name: "Larger text" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(sw.getAttribute("type")).toBe("button");
  });

  it("reports the flipped value on click", async () => {
    const onChange = vi.fn();
    render(<Switch checked ariaLabel="Strong focus" onChange={onChange} />);
    await userEvent.click(screen.getByRole("switch"));
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("ignores clicks while disabled", async () => {
    const onChange = vi.fn();
    render(<Switch checked={false} disabled ariaLabel="Busy" onChange={onChange} />);
    await userEvent.click(screen.getByRole("switch"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("exposes the styling hooks on the button, track and knob", () => {
    render(<Switch checked={false} ariaLabel="Hooks" onChange={() => {}} />);
    const sw = screen.getByRole("switch");
    expect(sw.classList.contains("sl-switch")).toBe(true);
    expect(sw.querySelector(".sl-switch-track > .sl-switch-knob")).not.toBeNull();
  });

  it("shows the on state on the track only when checked", () => {
    const { rerender } = render(<Switch checked ariaLabel="State" onChange={() => {}} />);
    const track = () => screen.getByRole("switch").querySelector(".sl-switch-track")!;
    expect(track().classList.contains("bg-slider-fill")).toBe(true);
    rerender(<Switch checked={false} ariaLabel="State" onChange={() => {}} />);
    expect(track().classList.contains("bg-surface-3")).toBe(true);
  });

  it("renders children as the label, before the track, and forwards title", () => {
    render(
      <Switch checked={false} title="Enable" onChange={() => {}}>
        <span>Canvas surround</span>
      </Switch>,
    );
    const sw = screen.getByRole("switch", { name: "Canvas surround" });
    expect(sw.firstElementChild?.textContent).toBe("Canvas surround");
    expect(sw.lastElementChild?.classList.contains("sl-switch-track")).toBe(true);
    expect(sw.title).toBe("Enable");
  });
});
