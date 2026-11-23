// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Every floating menu wears one surface (radius, fill, border, shadow), so the
// top-bar menus, the context menu, a Select's list and the status-bar popovers
// read as one family. Rows inside a padded menu take the smaller radius that
// keeps their corners parallel to the menu's.

import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MENU_SURFACE } from "./floating";
import { ContextMenu } from "./components/ContextMenu";
import { Select } from "./components/Select";
import { MenuItem, TopBarMenu } from "./components/TopBarMenu";
import { SurroundControl } from "./SurroundControl";
import {
  CANVAS_SURROUND_SHADES,
  DEFAULT_CANVAS_SURROUND_INDEX,
  updateSettings,
} from "@/state/settings-store";

const wearsSurface = (el: HTMLElement) =>
  MENU_SURFACE.split(" ").every((c) => el.classList.contains(c));

beforeEach(() => {
  updateSettings({
    canvasSurroundOverride: true,
    canvasSurround: CANVAS_SURROUND_SHADES[DEFAULT_CANVAS_SURROUND_INDEX].value,
  });
});

describe("floating menu surface", () => {
  it("is the top-bar menu's", async () => {
    const user = userEvent.setup();
    render(
      <TopBarMenu label="View">
        {() => (
          <MenuItem checked={false} onClick={() => {}}>
            Histogram
          </MenuItem>
        )}
      </TopBarMenu>,
    );
    await user.click(screen.getByRole("button", { name: "View" }));
    expect(wearsSurface(screen.getByRole("menu"))).toBe(true);
  });

  it("is the context menu's, whose danger rows fill solid on hover", () => {
    render(
      <ContextMenu
        x={10}
        y={10}
        items={[{ label: "Remove", danger: true, onClick: () => {} }]}
        onClose={() => {}}
      />,
    );
    expect(wearsSurface(screen.getByRole("menu"))).toBe(true);
    const remove = screen.getByRole("menuitem", { name: "Remove" });
    expect(remove.className).toContain("hover:bg-danger");
    expect(remove.className).toContain("hover:text-on-danger");
  });

  it("is a Select list's, with rows rounded to fit inside its padding", async () => {
    const user = userEvent.setup();
    render(
      <Select
        value="a"
        onChange={() => {}}
        ariaLabel="Pick"
        options={[
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta" },
        ]}
      />,
    );
    await user.click(screen.getByRole("combobox", { name: "Pick" }));
    expect(wearsSurface(screen.getByRole("listbox"))).toBe(true);
    const row = screen.getByRole("option", { name: "Beta" });
    expect(row.classList.contains("rounded-sm")).toBe(true);
  });

  it("is the surround popover's", async () => {
    const user = userEvent.setup();
    render(<SurroundControl />);
    await user.click(screen.getByRole("button", { name: "Choose surround shade" }));
    expect(wearsSurface(screen.getByRole("menu"))).toBe(true);
  });
});
