// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A slot draws what extensions put in it, and its fallback while nothing is
// there: Detail draws the built-in noise sliders until a denoiser fills
// develop-detail with its own.

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSlot, unregisterSlot } from "./registry";
import { Slot } from "./Slot";

const Wavelet = () => <p>wavelet controls</p>;

afterEach(() => {
  act(() => unregisterSlot("acme.denoise", "acme.denoise.controls"));
  cleanup();
});

describe("Slot", () => {
  it("draws its fallback while the slot is empty", () => {
    render(<Slot name="develop-detail" fallback={<p>built-in sliders</p>} />);
    expect(screen.getByText("built-in sliders")).toBeTruthy();
  });

  it("draws the slot's components in place of the fallback, and the fallback again once they go", () => {
    render(<Slot name="develop-detail" fallback={<p>built-in sliders</p>} />);
    act(() => registerSlot("acme.denoise", { id: "acme.denoise.controls", slot: "develop-detail", component: Wavelet }));
    expect(screen.getByText("wavelet controls")).toBeTruthy();
    expect(screen.queryByText("built-in sliders")).toBeNull();
    act(() => unregisterSlot("acme.denoise", "acme.denoise.controls"));
    expect(screen.getByText("built-in sliders")).toBeTruthy();
  });

  it("shows a component that throws as crashed and still draws the others", () => {
    // React still logs an error a boundary caught.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const Broken = () => {
      throw new Error("boom");
    };
    render(<Slot name="develop-detail" />);
    act(() => {
      registerSlot("acme.broken", { id: "acme.broken.controls", slot: "develop-detail", component: Broken });
      registerSlot("acme.denoise", { id: "acme.denoise.controls", slot: "develop-detail", component: Wavelet });
    });
    expect(screen.getByText('Slot item "acme.broken.controls" crashed: boom')).toBeTruthy();
    expect(screen.getByText("wavelet controls")).toBeTruthy();

    // A fixed component registered under the same id starts afresh.
    act(() =>
      registerSlot("acme.broken", {
        id: "acme.broken.controls",
        slot: "develop-detail",
        component: () => <p>fixed controls</p>,
      }),
    );
    expect(screen.getByText("fixed controls")).toBeTruthy();
    act(() => unregisterSlot("acme.broken", "acme.broken.controls"));
    error.mockRestore();
  });

  it("draws nothing for an empty slot without a fallback", () => {
    const { container } = render(<Slot name="develop-detail" />);
    expect(container.innerHTML).toBe("");
  });
});
