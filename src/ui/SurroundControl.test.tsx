// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The surround shade popover is a keyboard-operable menu: focus lands on the
// current shade, arrows move along the row, and closing returns focus to the
// swatch that opened it.

import { beforeEach, describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  CANVAS_SURROUND_SHADES,
  DEFAULT_CANVAS_SURROUND_INDEX,
  updateSettings,
  useSettings,
} from "@/state/settings-store";
import { popEscapeHandler } from "@/ui/escape-stack";
import { SurroundControl } from "./SurroundControl";

const trigger = () => screen.getByRole("button", { name: "Choose surround shade" });
const items = () => screen.getAllByRole("menuitemradio");
const LAST = CANVAS_SURROUND_SHADES.length - 1;

beforeEach(() => {
  updateSettings({
    canvasSurroundOverride: true,
    canvasSurround: CANVAS_SURROUND_SHADES[DEFAULT_CANVAS_SURROUND_INDEX].value,
  });
});

describe("SurroundControl keyboard", () => {
  it("focuses the current shade when the menu opens", async () => {
    const user = userEvent.setup();
    render(<SurroundControl />);
    await user.click(trigger());
    expect(document.activeElement).toBe(items()[DEFAULT_CANVAS_SURROUND_INDEX]);
  });

  it("moves along the row with arrow keys, wrapping at the ends", async () => {
    updateSettings({ canvasSurround: CANVAS_SURROUND_SHADES[LAST].value });
    const user = userEvent.setup();
    render(<SurroundControl />);
    await user.click(trigger());
    expect(document.activeElement).toBe(items()[LAST]);
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(items()[0]);
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(items()[LAST]);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(items()[0]);
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(items()[LAST]);
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(items()[0]);
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(items()[LAST]);
  });

  it("returns focus to the swatch on Escape", async () => {
    const user = userEvent.setup();
    render(<SurroundControl />);
    await user.click(trigger());
    act(() => {
      popEscapeHandler();
    });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("applies the shade and returns focus to the swatch when one is chosen", async () => {
    const user = userEvent.setup();
    render(<SurroundControl />);
    await user.click(trigger());
    await user.click(items()[0]);
    expect(useSettings.getState().canvasSurround).toBe(CANVAS_SURROUND_SHADES[0].value);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("leaves focus alone when an outside press closes it", async () => {
    const user = userEvent.setup();
    render(
      <>
        <SurroundControl />
        <input aria-label="elsewhere" />
      </>,
    );
    await user.click(trigger());
    await user.click(screen.getByLabelText("elsewhere"));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText("elsewhere"));
  });
});
