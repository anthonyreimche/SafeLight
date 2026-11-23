// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Tests for the top-bar dropdowns: open/close, dismissal, where focus lands
// when the panel goes away, arrow keys, and moving between sibling menus the
// way a menubar does.

import { describe, it, expect, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { popEscapeHandler } from "@/ui/escape-stack";
import { MenuItem, MenuLabel, TopBarMenu } from "./TopBarMenu.tsx";

const trigger = (name = "View") => screen.getByRole("button", { name });
const item = (name: string) => screen.getByRole("menuitemcheckbox", { name });
const queryItem = (name: string) => screen.queryByRole("menuitemcheckbox", { name });

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
          <MenuItem checked={false} onClick={() => {}}>
            Snapshots
          </MenuItem>
        </>
      )}
    </TopBarMenu>
  );
}

function MenuBar() {
  return (
    <>
      <TopBarMenu label="View">
        {() => (
          <MenuItem checked={false} onClick={() => {}}>
            Histogram
          </MenuItem>
        )}
      </TopBarMenu>
      <TopBarMenu label="Layout">
        {() => (
          <MenuItem checked={false} onClick={() => {}}>
            Classic
          </MenuItem>
        )}
      </TopBarMenu>
    </>
  );
}

describe("TopBarMenu", () => {
  it("advertises a collapsed popup until it is opened", () => {
    render(<Menu />);
    expect(trigger().getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(queryItem("Histogram")).toBeNull();
  });

  it("toggles on the trigger", async () => {
    const user = userEvent.setup();
    render(<Menu />);

    await user.click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.getByText("Panels")).toBeTruthy();

    await user.click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(queryItem("Histogram")).toBeNull();
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
    expect(document.activeElement).toBe(item("Histogram"));

    await user.keyboard("{Escape}");
    expect(queryItem("Histogram")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("returns focus to the trigger when an item dismisses the menu itself", async () => {
    const user = userEvent.setup();
    render(<Menu dismissOnPick />);

    await user.click(trigger());
    await user.click(item("Histogram"));
    expect(queryItem("Histogram")).toBeNull();
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

  it("moves through its items with the arrow keys, Home and End", async () => {
    const user = userEvent.setup();
    render(<Menu />);
    await user.click(trigger());

    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(item("Presets"));
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(item("Snapshots"));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(item("Histogram"));
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(item("Snapshots"));
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(item("Histogram"));
  });

  it("opens from the keyboard with ArrowDown on the trigger", async () => {
    const user = userEvent.setup();
    render(<Menu />);
    trigger().focus();

    await user.keyboard("{ArrowDown}");
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(item("Histogram"));
  });
});

describe("TopBarMenu as a menubar", () => {
  it("switches to a sibling menu when its trigger is hovered while one is open", async () => {
    const user = userEvent.setup();
    render(<MenuBar />);

    await user.click(trigger("View"));
    await user.hover(trigger("Layout"));
    expect(item("Classic")).toBeTruthy();
    expect(queryItem("Histogram")).toBeNull();
    expect(trigger("View").getAttribute("aria-expanded")).toBe("false");
  });

  it("does not open a menu on hover while none is open", async () => {
    const user = userEvent.setup();
    render(<MenuBar />);

    await user.hover(trigger("Layout"));
    expect(queryItem("Classic")).toBeNull();
  });

  it("moves to the next and previous menus with the arrow keys, wrapping", async () => {
    const user = userEvent.setup();
    render(<MenuBar />);
    await user.click(trigger("View"));

    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(item("Classic"));
    expect(queryItem("Histogram")).toBeNull();

    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(item("Histogram"));

    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(item("Classic"));
  });

  it("closes the open menu when the other trigger is clicked open", async () => {
    const user = userEvent.setup();
    render(<MenuBar />);

    await user.click(trigger("View"));
    await user.click(trigger("Layout"));
    expect(item("Classic")).toBeTruthy();
    expect(queryItem("Histogram")).toBeNull();
  });
});

describe("MenuItem", () => {
  it("exposes its tick as checked state rather than in the accessible name", async () => {
    const user = userEvent.setup();
    render(<Menu />);
    await user.click(trigger());

    expect(item("Histogram").getAttribute("aria-checked")).toBe("true");
    expect(item("Presets").getAttribute("aria-checked")).toBe("false");
    expect(item("Presets").getAttribute("title")).toBe("Not open");
  });
});
