// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The bar that says an installed extension was turned off because the registry
// flagged it, one line per extension.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ExtensionSecurityBanner } from "./ExtensionSecurityBanner";
import { useTrust } from "./trust";

beforeEach(() => {
  useTrust.setState({
    flagged: [
      { id: "a.grain", name: "Film Grain", reason: "it sends photos away" },
      { id: "b.sky", name: "Sky Swap", reason: "it runs code it downloads" },
    ],
  });
});

afterEach(() => {
  cleanup();
  useTrust.setState({ flagged: [], dismissedFlags: [] });
});

describe("ExtensionSecurityBanner", () => {
  it("names every flagged extension and why, each as its own alert", () => {
    render(<ExtensionSecurityBanner />);

    const [grain, sky] = screen.getAllByRole("alert");
    for (const alert of [grain, sky]) expect(alert.getAttribute("aria-live")).toBeNull();
    expect(grain.textContent).toContain(
      "“Film Grain” was turned off because the extension registry flagged it: it sends photos away.",
    );
    expect(sky.textContent).toContain(
      "“Sky Swap” was turned off because the extension registry flagged it: it runs code it downloads.",
    );
  });

  it("paints with the danger token, not a label colour", () => {
    render(<ExtensionSecurityBanner />);

    const banner = screen.getAllByRole("alert")[0].closest("[data-extension-security]") as HTMLElement;
    expect(banner.outerHTML).not.toContain("label-red");
    expect(banner.outerHTML).toContain("danger");
  });

  it("dismisses one extension's line, leaving the others", async () => {
    render(<ExtensionSecurityBanner />);

    const grain = screen.getAllByRole("alert")[0];
    await userEvent.click(within(grain).getByRole("button", { name: "Dismiss" }));

    expect(screen.getAllByRole("alert").map((a) => a.textContent)).toEqual([
      expect.stringContaining("Sky Swap"),
    ]);
    expect(useTrust.getState().flagged.map((f) => f.id)).toEqual(["a.grain", "b.sky"]);
  });
});
