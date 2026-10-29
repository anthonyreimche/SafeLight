// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Tests for the shared window chrome: dialog semantics, focus handling, the
// outside-click dismiss, and titlebar dragging.

import { useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModalWindow } from "./ModalWindow.tsx";

const dialog = () => screen.getByRole("dialog");

function backdrop(): HTMLElement {
  const el = dialog().parentElement;
  if (!el) throw new Error("dialog has no backdrop");
  return el;
}

function titlebar(title: string): HTMLElement {
  const el = screen.getByText(title).parentElement;
  if (!el) throw new Error("title has no titlebar");
  return el;
}

/** A dialog behind a trigger, so focus restoration has somewhere to restore to. */
function Host({ children }: { children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      {open && (
        <ModalWindow title="Preferences" onClose={() => setOpen(false)}>
          {children}
        </ModalWindow>
      )}
    </>
  );
}

describe("ModalWindow semantics", () => {
  it("is a modal dialog named by its titlebar", () => {
    render(
      <ModalWindow title="Extensions" onClose={vi.fn()}>
        <p>Body</p>
      </ModalWindow>,
    );
    expect(dialog().getAttribute("aria-modal")).toBe("true");
    expect(screen.getByRole("dialog", { name: "Extensions" })).toBe(dialog());
  });

  it("closes from the titlebar close button", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <ModalWindow title="Extensions" onClose={onClose}>
        <p>Body</p>
      </ModalWindow>,
    );
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on a backdrop press but not on a press inside the window", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <ModalWindow title="Extensions" onClose={onClose}>
        <p>Body</p>
      </ModalWindow>,
    );

    await user.click(screen.getByText("Body"));
    expect(onClose).not.toHaveBeenCalled();

    await user.click(backdrop());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("ModalWindow focus", () => {
  it("takes focus on open and gives it back to the trigger on close", async () => {
    const user = userEvent.setup();
    render(
      <Host>
        <p>Body</p>
      </Host>,
    );
    const open = screen.getByRole("button", { name: "Open" });

    await user.click(open);
    expect(document.activeElement).toBe(dialog());

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(open);
  });

  it("leaves focus alone when a child claims it", async () => {
    const user = userEvent.setup();
    render(
      <Host>
        <input autoFocus aria-label="Search" />
      </Host>,
    );
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Search" }));
  });
});

describe("ModalWindow focus trap", () => {
  afterEach(() => vi.restoreAllMocks());

  // The trap drops tab stops that aren't laid out, which jsdom reports for
  // everything because it has no layout engine. Pretend every element is on
  // screen; nothing in these fixtures is actually hidden.
  const layOutEverything = () =>
    vi
      .spyOn(Element.prototype, "getClientRects")
      .mockReturnValue([{} as DOMRect] as unknown as DOMRectList);

  const renderTrapped = () =>
    render(
      <ModalWindow title="Extensions" onClose={vi.fn()}>
        <button type="button">Apply</button>
      </ModalWindow>,
    );

  it("wraps Tab from the last tab stop back to the first", async () => {
    const user = userEvent.setup();
    renderTrapped();
    layOutEverything();

    screen.getByRole("button", { name: "Apply" }).focus();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
  });

  it("wraps Shift+Tab from the first tab stop round to the last", async () => {
    const user = userEvent.setup();
    renderTrapped();
    layOutEverything();

    screen.getByRole("button", { name: "Close" }).focus();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Apply" }));
  });

  it("wraps Shift+Tab from the dialog itself round to the last tab stop", async () => {
    const user = userEvent.setup();
    renderTrapped();
    layOutEverything();

    dialog().focus();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Apply" }));
  });
});

describe("ModalWindow dragging", () => {
  const drag = (
    user: ReturnType<typeof userEvent.setup>,
    target: Element,
    from: { x: number; y: number },
    to: { x: number; y: number },
  ) =>
    user.pointer([
      { keys: "[MouseLeft>]", target, coords: { clientX: from.x, clientY: from.y } },
      { target, coords: { clientX: to.x, clientY: to.y } },
      { keys: "[/MouseLeft]", target, coords: { clientX: to.x, clientY: to.y } },
    ]);

  const renderDraggable = () =>
    render(
      <ModalWindow title="Preferences" onClose={vi.fn()}>
        <p>Body</p>
      </ModalWindow>,
    );

  it("moves the window by the pointer delta", async () => {
    const user = userEvent.setup();
    renderDraggable();

    await drag(user, titlebar("Preferences"), { x: 100, y: 50 }, { x: 130, y: 90 });
    expect(dialog().style.transform).toBe("translate(30px, 40px)");
  });

  it("leaves the window alone when the drag starts on a titlebar control", async () => {
    const user = userEvent.setup();
    renderDraggable();

    await drag(
      user,
      screen.getByRole("button", { name: "Close" }),
      { x: 100, y: 50 },
      { x: 130, y: 90 },
    );
    expect(dialog().style.transform).toBe("");
  });

  it("stays put while maximized", async () => {
    const user = userEvent.setup();
    render(
      <ModalWindow title="Preferences" onClose={vi.fn()} maximized onToggleMaximize={vi.fn()}>
        <p>Body</p>
      </ModalWindow>,
    );

    await drag(user, titlebar("Preferences"), { x: 100, y: 50 }, { x: 130, y: 90 });
    expect(dialog().style.transform).toBe("");
  });

  it("stops tracking a cancelled pointer", async () => {
    const user = userEvent.setup();
    renderDraggable();
    const bar = titlebar("Preferences");

    await user.pointer([
      { keys: "[MouseLeft>]", target: bar, coords: { clientX: 100, clientY: 50 } },
      { target: bar, coords: { clientX: 130, clientY: 90 } },
    ]);
    // user-event has no cancel gesture; browsers fire this when they take the
    // pointer over (scrolling, gesture recognition), and it must end the drag.
    fireEvent.pointerCancel(bar, { pointerId: 1 });
    fireEvent.pointerMove(bar, { pointerId: 1, clientX: 400, clientY: 400 });

    expect(dialog().style.transform).toBe("translate(30px, 40px)");
  });
});

describe("ModalWindow maximize", () => {
  it("has no maximize control unless the caller can toggle it", () => {
    render(
      <ModalWindow title="Preferences" onClose={vi.fn()}>
        <p>Body</p>
      </ModalWindow>,
    );
    expect(screen.queryByRole("button", { name: "Maximize" })).toBeNull();
  });

  it("offers Maximize beside the close button while windowed", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <ModalWindow title="Extensions" onClose={vi.fn()} maximized={false} onToggleMaximize={onToggle}>
        <p>Body</p>
      </ModalWindow>,
    );
    const button = screen.getByRole("button", { name: "Maximize" });
    expect(button.nextElementSibling).toBe(screen.getByRole("button", { name: "Close" }));
    expect(dialog().dataset.maximized).toBeUndefined();

    await user.click(button);
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("offers Restore and fills the window while maximized", () => {
    render(
      <ModalWindow title="Extensions" onClose={vi.fn()} maximized onToggleMaximize={vi.fn()}>
        <p>Body</p>
      </ModalWindow>,
    );
    expect(screen.getByRole("button", { name: "Restore" })).toBeTruthy();
    expect(dialog().dataset.maximized).toBe("true");
  });

  // Maximized, the titlebar sits where Electron draws the OS title bar: it must
  // leave room for the native min/max/close overlay (Windows/Linux) or that
  // overlay covers Restore and ×, and it takes over the overlay's colour.
  it("clears the native window controls only while maximized", () => {
    const { rerender } = render(
      <ModalWindow title="Extensions" onClose={vi.fn()} maximized={false} onToggleMaximize={vi.fn()}>
        <p>Body</p>
      </ModalWindow>,
    );
    expect(titlebar("Extensions").style.paddingRight).toBe("");

    rerender(
      <ModalWindow title="Extensions" onClose={vi.fn()} maximized onToggleMaximize={vi.fn()}>
        <p>Body</p>
      </ModalWindow>,
    );
    expect(titlebar("Extensions").style.paddingRight).toBe("138px");
  });

  it("colours the native window controls to match while maximized", () => {
    const setOverlay = vi.fn(async () => {});
    vi.stubGlobal("safelightNative", { titlebar: { setOverlay } });
    const root = document.documentElement.style;
    root.setProperty("--color-surface-2", "#303030");
    root.setProperty("--color-text-secondary", "#c0c0c0");
    try {
      const { rerender } = render(
        <ModalWindow title="Extensions" onClose={vi.fn()} maximized={false} onToggleMaximize={vi.fn()}>
          <p>Body</p>
        </ModalWindow>,
      );
      expect(setOverlay).not.toHaveBeenCalled();

      rerender(
        <ModalWindow title="Extensions" onClose={vi.fn()} maximized onToggleMaximize={vi.fn()}>
          <p>Body</p>
        </ModalWindow>,
      );
      expect(setOverlay).toHaveBeenLastCalledWith("#303030", "#c0c0c0");
    } finally {
      vi.unstubAllGlobals();
      document.documentElement.removeAttribute("style");
    }
  });

  it("toggles on a titlebar double-click", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <ModalWindow title="Extensions" onClose={vi.fn()} maximized={false} onToggleMaximize={onToggle}>
        <p>Body</p>
      </ModalWindow>,
    );
    await user.dblClick(titlebar("Extensions"));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("leaves double-clicks on titlebar controls alone", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <ModalWindow
        title="Extensions"
        onClose={vi.fn()}
        maximized={false}
        onToggleMaximize={onToggle}
        titlebar={<input aria-label="Search" />}
      >
        <p>Body</p>
      </ModalWindow>,
    );
    await user.dblClick(screen.getByLabelText("Search"));
    expect(onToggle).not.toHaveBeenCalled();
  });
});
