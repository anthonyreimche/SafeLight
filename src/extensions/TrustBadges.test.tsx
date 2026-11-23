// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Trust badges carry safety information at 9-10px, so their words must read:
// coloured text on a faint tint of the same colour came out near 1.5:1. The
// colour stays in the tick and the tint; the words take the theme's text
// colour, and Flagged is a solid danger chip. Both are status chips, so both
// take the square corners (pills are for tags you can click).

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { FlaggedBadge, VerifiedBadge } from "./TrustBadges";

describe("trust badges", () => {
  it("writes Verified in the text colour, keeping the green in its tick", () => {
    render(<VerifiedBadge />);
    const badge = screen.getByText(/Verified/).closest("span[title]") as HTMLElement;
    expect(badge.className).toContain("text-text-primary");
    expect(badge.classList.contains("rounded")).toBe(true);
    expect(badge.classList.contains("rounded-full")).toBe(false);
  });

  it("draws Flagged as a solid danger chip", () => {
    render(<FlaggedBadge reason="Steals files" />);
    const badge = screen.getByTitle("Steals files");
    expect(badge.className).toContain("bg-danger");
    expect(badge.className).toContain("text-on-danger");
  });
});
