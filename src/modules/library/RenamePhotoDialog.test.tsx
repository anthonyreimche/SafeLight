// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The rename dialog is the last gate before a name reaches the filesystem, so
// its job is to refuse everything the disk would refuse — blank, illegal
// characters, a name already spoken for — and to hand back exactly the text the
// user meant, trimmed.

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RenamePhotoDialog } from "./RenamePhotoDialog";

const TITLE = "Rename photo";

function setup(props: Partial<Parameters<typeof RenamePhotoDialog>[0]> = {}) {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  const view = render(
    <RenamePhotoDialog
      title={TITLE}
      value="IMG_0001"
      suffix=".NEF"
      onSubmit={onSubmit}
      onCancel={onCancel}
      {...props}
    />,
  );
  return {
    ...view,
    onSubmit,
    onCancel,
    user: userEvent.setup(),
    field: screen.getByRole<HTMLInputElement>("textbox", { name: TITLE }),
    rename: screen.getByRole<HTMLButtonElement>("button", { name: "Rename" }),
  };
}

describe("submitting", () => {
  it("hands back the name without the surrounding whitespace", async () => {
    const { user, field, rename, onSubmit } = setup();
    await user.clear(field);
    await user.type(field, "  Sunrise ridge  ");
    await user.click(rename);
    expect(onSubmit).toHaveBeenCalledWith("Sunrise ridge");
  });

  it("submits on Enter and leaves the locked extension out of the value", async () => {
    const { user, field, onSubmit } = setup({ prefix: "IMG_0001_", suffix: ".NEF" });
    await user.clear(field);
    await user.type(field, "hero{Enter}");
    expect(onSubmit).toHaveBeenCalledWith("hero");
    expect(screen.getByText("IMG_0001_")).toBeTruthy();
    expect(screen.getByText(".NEF")).toBeTruthy();
  });
});

describe("rejecting", () => {
  it("refuses a blank name, and Enter cannot force it through", async () => {
    const { user, field, rename, onSubmit } = setup();
    await user.clear(field);
    expect(rename.disabled).toBe(true);

    await user.type(field, "{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("refuses a name that is only whitespace", async () => {
    const { user, field, rename, onSubmit } = setup();
    await user.clear(field);
    await user.type(field, "   ");
    expect(rename.disabled).toBe(true);

    await user.type(field, "{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("names the illegal path characters instead of failing later on disk", async () => {
    const { user, field, rename, onSubmit } = setup();
    await user.clear(field);
    await user.type(field, "a/b:c");
    expect(rename.disabled).toBe(true);
    expect(screen.getByText(/can't contain/i)).toBeTruthy();

    await user.type(field, "{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("refuses a name already taken, ignoring case as the filesystem does", async () => {
    const { user, field, rename, onSubmit } = setup({
      takenNames: ["IMG_0002", "Sunrise"],
    });
    await user.clear(field);
    await user.type(field, "  sunRISE  ");
    expect(rename.disabled).toBe(true);
    expect(screen.getByText(/already taken/i)).toBeTruthy();

    await user.type(field, "{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("clears the collision as soon as the name diverges", async () => {
    const { user, field, rename, onSubmit } = setup({ takenNames: ["IMG_0002"] });
    await user.clear(field);
    await user.type(field, "IMG_0002");
    expect(rename.disabled).toBe(true);

    await user.type(field, "b");
    expect(rename.disabled).toBe(false);
    await user.click(rename);
    expect(onSubmit).toHaveBeenCalledWith("IMG_0002b");
  });

  it("lets the photo keep a name it does not itself hold", async () => {
    // The caller excludes the target from `takenNames`, so re-submitting the
    // current name is a legal no-op rather than a self-collision.
    const { rename, onSubmit, user } = setup({ takenNames: ["IMG_0002"] });
    await user.click(rename);
    expect(onSubmit).toHaveBeenCalledWith("IMG_0001");
  });
});

describe("dismissing", () => {
  it("cancels on Escape", async () => {
    const { user, field, onCancel, onSubmit } = setup();
    await user.type(field, "{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("cancels from the Cancel button", async () => {
    const { user, onCancel } = setup();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("cancels on a click outside the card but not inside it", async () => {
    // The backdrop is the dialog's own root element; only a click that lands on
    // it (rather than bubbling from the card) dismisses.
    const { user, container, field, onCancel } = setup();
    await user.click(field);
    expect(onCancel).not.toHaveBeenCalled();

    await user.click(container.firstElementChild as HTMLElement);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
