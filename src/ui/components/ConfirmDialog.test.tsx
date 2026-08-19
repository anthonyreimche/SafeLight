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
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { popEscapeHandler } from "@/ui/escape-stack";
import { ConfirmDialogHost, confirmDialog } from "./ConfirmDialog";

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
