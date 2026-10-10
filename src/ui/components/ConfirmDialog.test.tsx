// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// In-app replacement for native window.confirm. Native confirm/alert suspend
// Electron's renderer and can desync window focus (keystrokes stop reaching
// inputs until refocus/restart — electron#31917), so callers await
// confirmDialog() and ConfirmDialogHost renders the card in-page. These tests
// pin the promise contract, keyboard/focus behavior, and FIFO queueing.

import { describe, expect, it } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { popEscapeHandler } from "@/ui/escape-stack";
import { ConfirmDialogHost, alertDialog, confirmDialog } from "./ConfirmDialog";

describe("confirmDialog", () => {
  it("resolves true when the confirm button is clicked", async () => {
    const user = userEvent.setup();
    render(<ConfirmDialogHost />);
    let decision!: Promise<boolean>;
    act(() => {
      decision = confirmDialog({
        title: "Unreviewed extension",
        message: "Install at your own risk.",
        confirmLabel: "Install anyway",
      });
    });
    const dialog = screen.getByRole("dialog", { name: "Unreviewed extension" });
    expect(dialog.textContent).toContain("Install at your own risk.");
    await user.click(screen.getByRole("button", { name: "Install anyway" }));
    await expect(decision).resolves.toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("resolves false when the cancel button is clicked", async () => {
    const user = userEvent.setup();
    render(<ConfirmDialogHost />);
    let decision!: Promise<boolean>;
    act(() => {
      decision = confirmDialog({ title: "Reset edits", message: "Sure?" });
    });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(decision).resolves.toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("resolves false when the backdrop is clicked", async () => {
    const user = userEvent.setup();
    render(<ConfirmDialogHost />);
    let decision!: Promise<boolean>;
    act(() => {
      decision = confirmDialog({ title: "Reset edits", message: "Sure?" });
    });
    const backdrop = screen.getByRole("dialog").parentElement as HTMLElement;
    await user.click(backdrop);
    await expect(decision).resolves.toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("resolves false when the escape stack pops it", async () => {
    render(<ConfirmDialogHost />);
    let decision!: Promise<boolean>;
    act(() => {
      decision = confirmDialog({ title: "Reset edits", message: "Sure?" });
    });
    let consumed = false;
    act(() => {
      consumed = popEscapeHandler();
    });
    expect(consumed).toBe(true);
    await expect(decision).resolves.toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("focuses the confirm button on open and restores focus on close", async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">outside</button>
        <ConfirmDialogHost />
      </>,
    );
    const outside = screen.getByRole("button", { name: "outside" });
    outside.focus();
    let decision!: Promise<boolean>;
    act(() => {
      decision = confirmDialog({ title: "Reset edits", message: "Sure?" });
    });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "OK" }));
    await user.click(screen.getByRole("button", { name: "OK" }));
    await decision;
    expect(document.activeElement).toBe(outside);
  });

  it("renders blank-line-separated message text as separate paragraphs", async () => {
    const user = userEvent.setup();
    render(<ConfirmDialogHost />);
    let decision!: Promise<boolean>;
    act(() => {
      decision = confirmDialog({
        title: "Before installing extensions",
        message: "Extensions are third-party code.\n\nInstall at your own risk.",
      });
    });
    screen.getByText("Extensions are third-party code.");
    screen.getByText("Install at your own risk.");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await decision;
  });

  it("styles the confirm button by variant — red for danger, accent otherwise", async () => {
    const user = userEvent.setup();
    render(<ConfirmDialogHost />);
    let danger!: Promise<boolean>;
    act(() => {
      danger = confirmDialog({
        title: "Delete from disk",
        message: "Move 3 photos to the Trash?",
        confirmLabel: "Move to Trash",
        variant: "danger",
      });
    });
    const dangerButton = screen.getByRole("button", { name: "Move to Trash" });
    expect(dangerButton.className).toContain("var(--color-label-red)");
    expect(dangerButton.className).not.toContain("var(--color-accent)");
    await user.click(dangerButton);
    await danger;

    let plain!: Promise<boolean>;
    act(() => {
      plain = confirmDialog({ title: "Reset edits", message: "Sure?" });
    });
    expect(screen.getByRole("button", { name: "OK" }).className).toContain(
      "var(--color-accent)",
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await plain;
  });

  it("keeps single-newline line structure within a message paragraph", async () => {
    const user = userEvent.setup();
    render(<ConfirmDialogHost />);
    let decision!: Promise<boolean>;
    act(() => {
      decision = confirmDialog({
        title: "Delete from disk",
        message: "Couldn't delete 2 files:\n• a.NEF — locked\n• b.NEF — busy",
      });
    });
    const paragraph = screen.getByText(/a\.NEF/);
    expect(paragraph.className).toContain("whitespace-pre-line");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await decision;
  });

  it("queues concurrent requests, first in first out", async () => {
    const user = userEvent.setup();
    render(<ConfirmDialogHost />);
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = confirmDialog({ title: "First question", message: "A" });
      second = confirmDialog({ title: "Second question", message: "B" });
    });
    screen.getByRole("dialog", { name: "First question" });
    expect(screen.queryByRole("dialog", { name: "Second question" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "OK" }));
    await expect(first).resolves.toBe(true);
    screen.getByRole("dialog", { name: "Second question" });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(second).resolves.toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("alertDialog", () => {
  it("shows one acknowledge button and resolves once it's clicked", async () => {
    const user = userEvent.setup();
    render(<ConfirmDialogHost />);
    let done = false;
    let notice!: Promise<void>;
    act(() => {
      notice = alertDialog({
        title: "Export data",
        message: "Wrote 3 sidecar files.",
      }).then(() => {
        done = true;
      });
    });
    const dialog = screen.getByRole("alertdialog", { name: "Export data" });
    expect(dialog.textContent).toContain("Wrote 3 sidecar files.");
    expect(within(dialog).queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(within(dialog).getAllByRole("button")).toHaveLength(1);
    await user.click(within(dialog).getByRole("button", { name: "OK" }));
    await notice;
    expect(done).toBe(true);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("resolves when dismissed by the escape stack", async () => {
    render(<ConfirmDialogHost />);
    let notice!: Promise<void>;
    act(() => {
      notice = alertDialog({ title: "Export data", message: "Done." });
    });
    let consumed = false;
    act(() => {
      consumed = popEscapeHandler();
    });
    expect(consumed).toBe(true);
    await expect(notice).resolves.toBeUndefined();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("queues behind confirms in the same FIFO", async () => {
    const user = userEvent.setup();
    render(<ConfirmDialogHost />);
    let question!: Promise<boolean>;
    let notice!: Promise<void>;
    act(() => {
      question = confirmDialog({ title: "First question", message: "A" });
      notice = alertDialog({ title: "Heads up", message: "B" });
    });
    screen.getByRole("dialog", { name: "First question" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "OK" }));
    await expect(question).resolves.toBe(true);
    screen.getByRole("alertdialog", { name: "Heads up" });
    await user.click(screen.getByRole("button", { name: "OK" }));
    await expect(notice).resolves.toBeUndefined();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
