// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Tests for the top-bar dropdown: open/close, dismissal, and where focus lands
// when the panel goes away.

import { describe, it, expect, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { popEscapeHandler } from "@/ui/escape-stack";
import { MenuItem, MenuLabel, TopBarMenu } from "./TopBarMenu.tsx";

const trigger = () => screen.getByRole("button", { name: "View" });
const item = (name: string) => screen.getByRole("button", { name });

/** What the app's global Escape handler does: run the topmost registration. */
function globalEscape(): boolean {
  let consumed = false;
  act(() => {
    consumed = popEscapeHandler();
  });
  return consumed;
}

function Menu({ onPick, dismissOnPick = false }: { onPick?: () => void; dismissOnPick?: boolean }) {
  return (
    <TopBarMenu label="View">
      {(close) => (
        <>
          <MenuLabel>Panels</MenuLabel>
          <MenuItem
            checked
            onClick={() => {
              onPick?.();
              if (dismissOnPick) close();
            }}
          >
            Histogram
          </MenuItem>
          <MenuItem checked={false} title="Not open" onClick={() => {}}>
            Presets
          </MenuItem>
        </>
      )}
    </TopBarMenu>
  );
}

describe("TopBarMenu", () => {
  it("advertises a collapsed popup until it is opened", () => {
    render(<Menu />);
    expect(trigger().getAttribute("aria-haspopup")).toBe("true");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Histogram" })).toBeNull();
  });

  it("toggles on the trigger", async () => {
    const user = userEvent.setup();
    render(<Menu />);

    await user.click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Panels")).toBeTruthy();

    await user.click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Histogram" })).toBeNull();
  });

  it("stays open while items are used, and closes on a press outside", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<Menu onPick={onPick} />);

    await user.click(trigger());
    await user.click(item("Histogram"));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");

    await user.click(document.body);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<Menu />);

    await user.click(trigger());
    await user.tab();
    expect(document.activeElement).toBe(item("Histogram"));

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("button", { name: "Histogram" })).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("returns focus to the trigger when an item dismisses the menu itself", async () => {
    const user = userEvent.setup();
    render(<Menu dismissOnPick />);

    await user.click(trigger());
    await user.click(item("Histogram"));
    expect(screen.queryByRole("button", { name: "Histogram" })).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("registers on the escape stack only while open", async () => {
    const user = userEvent.setup();
    render(<Menu />);
    expect(globalEscape()).toBe(false);

    await user.click(trigger());
    expect(globalEscape()).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(globalEscape()).toBe(false);
  });

  it("unregisters when unmounted while open", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Menu />);
    await user.click(trigger());
    unmount();

    expect(globalEscape()).toBe(false);
  });
});

describe("MenuItem", () => {
  it("exposes its tick as toggle state rather than in the accessible name", async () => {
    const user = userEvent.setup();
    render(<Menu />);
    await user.click(trigger());

    expect(item("Histogram").getAttribute("aria-pressed")).toBe("true");
    expect(item("Presets").getAttribute("aria-pressed")).toBe("false");
    expect(item("Presets").getAttribute("title")).toBe("Not open");
  });
});
