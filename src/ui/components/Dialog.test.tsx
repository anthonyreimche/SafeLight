// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The small dialogue shell: a backdrop press dismisses it, but a text selection
// dragged out of a field must not, and Enter runs the dialogue's main action
// unless a button or a multi-line field has the key.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Dialog } from "./Dialog";

function setup(onSubmit?: () => void) {
  const onClose = vi.fn();
  render(
    <Dialog labelledBy="t" onClose={onClose} onSubmit={onSubmit} className="">
      <div id="t">Rename</div>
      <input aria-label="Name" defaultValue="IMG_0001" />
      <textarea aria-label="Notes" />
      <button onClick={onClose}>Cancel</button>
    </Dialog>,
  );
  const backdrop = screen.getByRole("dialog").parentElement as HTMLElement;
  return { onClose, backdrop };
}

describe("Dialog", () => {
  it("closes on a press that starts and ends on the backdrop", () => {
    const { onClose, backdrop } = setup();
    fireEvent.pointerDown(backdrop);
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays open when a selection dragged out of a field ends on the backdrop", () => {
    const { onClose, backdrop } = setup();
    fireEvent.pointerDown(screen.getByRole("textbox", { name: "Name" }));
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("runs the main action on Enter", async () => {
    const onSubmit = vi.fn();
    setup(onSubmit);
    const user = userEvent.setup();
    await user.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("leaves Enter to a focused button or a multi-line field", async () => {
    const onSubmit = vi.fn();
    const { onClose } = setup(onSubmit);
    const user = userEvent.setup();

    screen.getByRole("textbox", { name: "Notes" }).focus();
    await user.keyboard("{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();

    screen.getByRole("button", { name: "Cancel" }).focus();
    await user.keyboard("{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
