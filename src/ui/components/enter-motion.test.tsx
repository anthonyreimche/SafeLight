// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Dialogs, popovers and banners play a one-shot enter animation. Each is a CSS
// class (killed by Reduce motion), so these pin which element carries which:
// frames pop, backdrops fade their dim, measured popovers only fade, banners rise.
// A backdrop never fades its opacity: an ancestor with an opacity effect is the
// backdrop root of the dialogue inside it, so a glass theme's frost on the
// dialogue would blur only the dim layer and come out an opaque slab.

import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useProjectStore } from "@/project/project-store";
import { Dialog } from "./Dialog";
import { ModalWindow } from "./ModalWindow";
import { ConfirmDialogHost, confirmDialog } from "./ConfirmDialog";
import { ContextMenu } from "./ContextMenu";
import { Select } from "./Select";
import { TopBarMenu } from "./TopBarMenu";
import { StorageBanner } from "./StorageBanner";

const backdropOf = (box: HTMLElement): HTMLElement => box.parentElement as HTMLElement;

function expectDimFade(backdrop: HTMLElement) {
  expect(backdrop.classList.contains("sl-enter-dim")).toBe(true);
  expect(backdrop.classList.contains("sl-enter-fade")).toBe(false);
}

describe("dialog enter motion", () => {
  it("Dialog pops its box and fades its backdrop's dim", () => {
    render(
      <Dialog labelledBy="h" onClose={vi.fn()} className="w-40">
        <h2 id="h">Rename</h2>
      </Dialog>,
    );
    const box = screen.getByRole("dialog");
    expect(box.classList.contains("sl-enter-pop")).toBe(true);
    expectDimFade(backdropOf(box));
  });

  it("ModalWindow pops its box and fades its backdrop's dim", () => {
    render(
      <ModalWindow title="Extensions" onClose={vi.fn()}>
        <p>Body</p>
      </ModalWindow>,
    );
    const box = screen.getByRole("dialog");
    expect(box.classList.contains("sl-enter-pop")).toBe(true);
    expectDimFade(backdropOf(box));
  });

  it("a moved ModalWindow keeps its inline transform beside the pop class", () => {
    render(
      <ModalWindow title="Extensions" onClose={vi.fn()}>
        <p>Body</p>
      </ModalWindow>,
    );
    const box = screen.getByRole("dialog");
    const bar = screen.getByText("Extensions").parentElement as HTMLElement;
    bar.setPointerCapture = vi.fn();
    bar.releasePointerCapture = vi.fn();
    box.getBoundingClientRect = () =>
      ({ left: 100, right: 300, top: 100, bottom: 300, width: 200, height: 200 }) as DOMRect;
    fireEvent.pointerDown(bar, { clientX: 150, clientY: 110, pointerId: 1 });
    fireEvent.pointerMove(bar, { clientX: 170, clientY: 130, pointerId: 1 });
    expect(box.style.transform).toBe("translate(20px, 20px)");
    expect(box.classList.contains("sl-enter-pop")).toBe(true);
  });

  it("ConfirmDialog pops its card and fades its backdrop's dim", () => {
    render(<ConfirmDialogHost />);
    act(() => {
      void confirmDialog({ title: "Reset", message: "Sure?" });
    });
    const card = screen.getByRole("dialog");
    expect(card.classList.contains("sl-enter-pop")).toBe(true);
    expectDimFade(backdropOf(card));
  });
});

describe("popover enter motion", () => {
  it("ContextMenu fades without moving or scaling", () => {
    render(<ContextMenu x={10} y={10} items={[{ label: "Open", onClick: () => {} }]} onClose={() => {}} />);
    const menu = screen.getByRole("menu");
    expect(menu.classList.contains("sl-enter-fade")).toBe(true);
    expect(menu.classList.contains("sl-enter-pop")).toBe(false);
  });

  it("Select's listbox fades", async () => {
    render(
      <Select
        ariaLabel="Preset"
        value="a"
        options={[{ value: "a", label: "A" }]}
        onChange={() => {}}
      />,
    );
    await userEvent.setup().click(screen.getByRole("combobox", { name: "Preset" }));
    expect(screen.getByRole("listbox").classList.contains("sl-enter-fade")).toBe(true);
  });

  it("TopBarMenu's panel fades", async () => {
    render(<TopBarMenu label="View">{() => <p>Item</p>}</TopBarMenu>);
    await userEvent.setup().click(screen.getByRole("button", { name: "View" }));
    const panel = screen.getByText("Item").parentElement as HTMLElement;
    expect(panel.classList.contains("sl-enter-fade")).toBe(true);
  });
});

describe("banner enter motion", () => {
  it("StorageBanner rises in", () => {
    useProjectStore.setState({ openError: "Couldn't open it.", openErrorReadOnly: false });
    render(<StorageBanner />);
    expect(screen.getByRole("alert").classList.contains("sl-enter-rise")).toBe(true);
    useProjectStore.setState({ openError: null });
  });
});

describe("Preferences enter motion", () => {
  it("fades each section's content in, keyed by the section", async () => {
    const { PreferencesDialog, openPreferences } = await import("./PreferencesDialog");
    render(<PreferencesDialog />);
    act(() => openPreferences());
    const first = document.querySelector(".sl-enter-fade.overflow-y-auto.p-4");
    expect(first).not.toBeNull();
    const rail = screen.getAllByRole("button").filter((b) => b.className.includes("tracking-wider"));
    fireEvent.click(rail[1]);
    const second = document.querySelector(".sl-enter-fade.overflow-y-auto.p-4");
    expect(second).not.toBe(first);
  });
});
