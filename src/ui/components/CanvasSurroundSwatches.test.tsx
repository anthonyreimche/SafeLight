// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The canvas-surround shade buttons shared by Preferences and the welcome
// setup: the active shade carries a check mark, not only a ring.

import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  CANVAS_SURROUND_SHADES,
  DEFAULT_CANVAS_SURROUND,
} from "@/state/settings-store";
import { CanvasSurroundSwatches } from "./CanvasSurroundSwatches";

const shades = () =>
  within(screen.getByRole("group", { name: "Canvas surround shade" })).getAllByRole(
    "button",
  );

describe("CanvasSurroundSwatches", () => {
  it("offers every shade and marks the active one", () => {
    render(
      <CanvasSurroundSwatches value={DEFAULT_CANVAS_SURROUND} enabled onChange={() => {}} />,
    );
    expect(shades().map((b) => b.getAttribute("aria-label"))).toEqual(
      CANVAS_SURROUND_SHADES.map((s) => s.label),
    );
    const active = screen.getByRole("button", { name: "Middle grey" });
    expect(active.getAttribute("aria-pressed")).toBe("true");
    expect(active.textContent).toBe("✓");
    const other = screen.getByRole("button", { name: "Black" });
    expect(other.getAttribute("aria-pressed")).toBe("false");
    expect(other.textContent).toBe("");
  });

  it("reports the picked shade", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <CanvasSurroundSwatches value={DEFAULT_CANVAS_SURROUND} enabled onChange={onChange} />,
    );
    await user.click(screen.getByRole("button", { name: "White" }));
    expect(onChange).toHaveBeenCalledWith("#ffffff");
  });

  it("is disabled while the surround follows the theme", () => {
    render(
      <CanvasSurroundSwatches
        value={DEFAULT_CANVAS_SURROUND}
        enabled={false}
        onChange={() => {}}
      />,
    );
    expect(shades().every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });
});
