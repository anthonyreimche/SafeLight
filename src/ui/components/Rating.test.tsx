// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The stars sit on a tile that selects when clicked: rating a photo must not
// also select it, and clicking the current rating clears it.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Rating } from "./Rating";

describe("Rating", () => {
  it("rates without the click reaching the tile beneath", () => {
    const onChange = vi.fn();
    const onTile = vi.fn();
    render(
      <div onClick={onTile}>
        <Rating value={1} onChange={onChange} />
      </div>,
    );

    fireEvent.click(screen.getByRole("button", { name: "4 stars" }));

    expect(onChange).toHaveBeenCalledWith(4);
    expect(onTile).not.toHaveBeenCalled();
  });

  it("clears the rating when its own star is clicked", () => {
    const onChange = vi.fn();
    render(<Rating value={3} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "3 stars" }));

    expect(onChange).toHaveBeenCalledWith(0);
  });
});
