// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The × that closes a notice: one look, one 24px target and one tooltip for
// every banner and notice, where each had its own padding and some no tooltip.

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DismissButton } from "./DismissButton";

describe("DismissButton", () => {
  it("is a 24px × named and titled Dismiss", async () => {
    const onClick = vi.fn();
    render(<DismissButton onClick={onClick} />);
    const button = screen.getByRole("button", { name: "Dismiss" });
    expect(button.getAttribute("title")).toBe("Dismiss");
    expect(button.textContent).toBe("×");
    expect(button.classList.contains("h-6")).toBe(true);
    expect(button.classList.contains("w-6")).toBe(true);
    await userEvent.setup().click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("takes a fuller name and tooltip where closing means more than dismiss", () => {
    render(<DismissButton onClick={() => {}} label="Close update notification" title="Close — reminds you next launch" />);
    const button = screen.getByRole("button", { name: "Close update notification" });
    expect(button.getAttribute("title")).toBe("Close — reminds you next launch");
  });
});
