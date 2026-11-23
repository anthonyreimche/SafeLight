// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Preferences ▸ Panel layout: a saved layout is gone for good once deleted, and
// its × sits beside the other row buttons, so deleting asks first.

import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRegistry } from "@/extensions/registry";
import { useUserLayouts } from "@/extensions/dock";
import { ConfirmDialogHost } from "@/ui/components/ConfirmDialog";
import { LayoutField } from "./LayoutField";

beforeEach(() => {
  useRegistry.setState({ layouts: {} });
  useUserLayouts.setState({
    layouts: { "user.a": { id: "user.a", name: "Culling", modules: {} } },
  });
});

function mount() {
  render(
    <>
      <LayoutField />
      <ConfirmDialogHost />
    </>,
  );
}

describe("deleting a saved layout", () => {
  it("asks first, and keeps the layout when cancelled", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "Delete Culling" }));

    const ask = await screen.findByRole("dialog", { name: "Delete Culling" });
    await user.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(useUserLayouts.getState().layouts["user.a"]).toBeTruthy();
  });

  it("deletes once confirmed", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "Delete Culling" }));

    const ask = await screen.findByRole("dialog", { name: "Delete Culling" });
    await user.click(within(ask).getByRole("button", { name: "Delete" }));
    expect(useUserLayouts.getState().layouts["user.a"]).toBeUndefined();
  });
});
