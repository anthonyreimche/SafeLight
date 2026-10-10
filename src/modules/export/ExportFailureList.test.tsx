// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Under an export's result, each photo that failed for a known reason is named
// with that reason, so the user learns why, not only how many.

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ExportFailureList } from "./ExportFailureList";

describe("the failures listed under an export's result", () => {
  it("name each photo with why it failed", () => {
    render(
      <ExportFailureList
        failures={[
          { filename: "a.RAF", reason: "The original isn't available." },
          { filename: "b.NEF", reason: "The original can't be read." },
        ]}
      />,
    );

    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "a.RAF: The original isn't available.",
      "b.NEF: The original can't be read.",
    ]);
  });

  it("name the first ten, and say how many more there are", () => {
    const failures = Array.from({ length: 12 }, (_, i) => ({
      filename: `p${i}.RAF`,
      reason: "The original isn't available.",
    }));

    render(<ExportFailureList failures={failures} />);

    const items = screen.getAllByRole("listitem").map((item) => item.textContent);
    expect(items).toHaveLength(11);
    expect(items[9]).toBe("p9.RAF: The original isn't available.");
    expect(items[10]).toBe("and 2 more.");
  });

  it("show nothing when no failure has a reason", () => {
    const { container } = render(<ExportFailureList failures={undefined} />);

    expect(container.querySelector("ul")).toBeNull();
  });
});
