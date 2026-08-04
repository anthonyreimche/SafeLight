// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Copy Settings fills a clipboard that Paste fans out over whole selections, so
// what the dialog hands back has to be exactly the ticked rows — no more. The
// per-image rows (framing, heal spots) are the ones that would do damage if they
// rode along uninvited.

import { describe, expect, it, vi, type Mock } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { normalizeParams, type RetouchSpot } from "@/catalog/types";
import type { DevelopClipboard } from "@/state/develop-clipboard";
import { CopySettingsDialog } from "./CopySettingsDialog";

const SPOT: RetouchSpot = {
  id: "spot-1",
  shape: "circle",
  mode: "heal",
  visible: true,
  dstX: 0.5,
  dstY: 0.5,
  srcX: 0.4,
  srcY: 0.4,
  radius: 0.04,
  feather: 50,
  opacity: 100,
};

function setup(
  overrides: Parameters<typeof normalizeParams>[0] = {},
  paramBag: Record<string, unknown> = {},
) {
  const onCopy = vi.fn<(clip: DevelopClipboard) => void>();
  const onCancel = vi.fn();
  const view = render(
    <CopySettingsDialog
      params={normalizeParams(overrides)}
      paramBag={paramBag}
      sourceName="IMG_0001.NEF"
      onCopy={onCopy}
      onCancel={onCancel}
    />,
  );
  return {
    ...view,
    onCopy,
    onCancel,
    user: userEvent.setup(),
    copy: screen.getByRole<HTMLButtonElement>("button", { name: "Copy" }),
  };
}

const box = (name: RegExp) => screen.getByRole<HTMLInputElement>("checkbox", { name });
const copied = (onCopy: Mock<(clip: DevelopClipboard) => void>) =>
  onCopy.mock.calls[0][0];

describe("what the clipboard carries", () => {
  it("starts from the changed global adjustments", async () => {
    const { user, copy, onCopy } = setup({ exposure: 1.2, contrast: 30 });
    await user.click(copy);
    expect(Object.keys(copied(onCopy).params).sort()).toEqual(["contrast", "exposure"]);
    expect(copied(onCopy).fieldCount).toBe(2);
  });

  it("drops a group as soon as its box is cleared", async () => {
    const { user, copy, onCopy } = setup({ exposure: 1.2, contrast: 30 });
    await user.click(box(/^Contrast/));
    await user.click(copy);
    expect(copied(onCopy).params).toEqual({ exposure: 1.2 });
    expect(copied(onCopy).fieldCount).toBe(1);
  });

  it("names the source photo it was copied from", async () => {
    const { user, copy, onCopy } = setup({ exposure: 1.2 });
    expect(screen.getByText(/IMG_0001\.NEF/)).toBeTruthy();
    await user.click(copy);
    expect(copied(onCopy).sourceName).toBe("IMG_0001.NEF");
  });

  it("refuses to copy nothing", async () => {
    const { user, copy, onCopy } = setup({ exposure: 1.2 });
    await user.click(box(/^Exposure/));
    expect(copy.disabled).toBe(true);
    await user.click(copy);
    expect(onCopy).not.toHaveBeenCalled();
  });
});

describe("per-image edits", () => {
  const perImage = { exposure: 1.2, retouch: [SPOT], crop: { x: 0.1, y: 0, width: 0.5, height: 1 } };

  it("lists framing and heal spots but never pre-selects them", async () => {
    const { user, copy, onCopy } = setup(perImage);
    expect(box(/^Crop & transform/).checked).toBe(false);
    expect(box(/^Retouch/).checked).toBe(false);

    await user.click(copy);
    expect(Object.keys(copied(onCopy).params)).toEqual(["exposure"]);
  });

  it("carries them once they are ticked on purpose", async () => {
    const { user, copy, onCopy } = setup(perImage);
    await user.click(box(/^Retouch/));
    await user.click(copy);
    expect(copied(onCopy).params.retouch?.map((s) => s.id)).toEqual([SPOT.id]);
  });
});

describe("extension stages", () => {
  it("offers no row when the photo has no stage params", () => {
    setup({ exposure: 1.2 });
    expect(screen.queryByRole("checkbox", { name: /Extension stages/ })).toBeNull();
  });

  it("copies the bag by value so later edits can't reach the clipboard", async () => {
    const bag = { "film.stock": "portra", "film.grain": 40 };
    const { user, copy, onCopy } = setup({ exposure: 1.2 }, bag);
    expect(box(/Extension stages/).checked).toBe(true);

    await user.click(copy);
    expect(copied(onCopy).paramBag).toEqual(bag);
    expect(copied(onCopy).paramBag).not.toBe(bag);
  });

  it("leaves the bag empty when the row is cleared", async () => {
    const { user, copy, onCopy } = setup({ exposure: 1.2 }, { "film.stock": "portra" });
    await user.click(box(/Extension stages/));
    await user.click(copy);
    expect(copied(onCopy).paramBag).toEqual({});
    expect(copied(onCopy).fieldCount).toBe(1);
  });
});

describe("Show all", () => {
  it("says so when an untouched photo has nothing to offer", () => {
    const { copy } = setup();
    expect(screen.getByText(/No adjustments on this photo/i)).toBeTruthy();
    expect(copy.disabled).toBe(true);
  });

  it("reveals the untouched adjustments without selecting any of them", async () => {
    const { user, copy, onCopy } = setup();
    await user.click(screen.getByRole("checkbox", { name: "Show all" }));

    const revealed = screen
      .getAllByRole<HTMLInputElement>("checkbox")
      .filter((c) => c !== screen.getByRole("checkbox", { name: "Show all" }));
    expect(revealed.length).toBeGreaterThan(0);
    expect(revealed.some((c) => c.checked)).toBe(false);
    expect(copy.disabled).toBe(true);

    await user.click(box(/^Vibrance/));
    await user.click(copy);
    expect(copied(onCopy).params).toEqual({ vibrance: 0 });
  });
});

describe("dismissing", () => {
  it("cancels from the Cancel button", async () => {
    const { user, onCancel, onCopy } = setup({ exposure: 1.2 });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCopy).not.toHaveBeenCalled();
  });

  it("cancels on a click outside the card but not inside it", async () => {
    // The backdrop is the dialog's own root element; only a click that lands on
    // it (rather than bubbling from the card) dismisses.
    const { user, container, onCancel } = setup({ exposure: 1.2 });
    await user.click(box(/^Exposure/));
    expect(onCancel).not.toHaveBeenCalled();

    await user.click(container.firstElementChild as HTMLElement);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
