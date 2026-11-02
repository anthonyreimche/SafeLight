// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The bars along the bottom of the window share one stack, so two at once sit
// one above the other instead of on top of each other, and a confirmation
// dialog covers them all.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { BottomBanners } from "./BottomBanners";
import { ConfirmDialogHost, confirmDialog } from "./ConfirmDialog";
import { ContextMenu } from "./ContextMenu";
import { Dialog } from "./Dialog";
import { useProjectStore } from "@/project/project-store";
import { useTrust } from "@/extensions/trust";
import { useSettings } from "@/state/settings-store";
import { useGraphics } from "@/state/graphics-store";
import { popEscapeHandler } from "@/ui/escape-stack";

const stack = () => document.querySelector<HTMLElement>("[data-bottom-banners]");
const zIndex = (el: Element | null) => Number(/\bz-\[(\d+)\]/.exec(el?.className ?? "")?.[1]);

beforeEach(() => {
  useSettings.setState({ checkForUpdates: false });
  useGraphics.setState({ noticeDismissed: true });
  useProjectStore.setState({
    openError: null,
    openErrorReadOnly: false,
    storageNotice: null,
    saveError: "Couldn't save the catalog: the disk is full.",
  });
  useTrust.setState({ flagged: [{ id: "x.y", name: "Film Grain", reason: "it sends photos away" }] });
});

afterEach(() => {
  act(() => void popEscapeHandler());
  cleanup();
  useTrust.setState({ flagged: [] });
  useProjectStore.setState({ saveError: null });
});

describe("BottomBanners", () => {
  it("stacks two banners shown at once in the one container", () => {
    render(<BottomBanners />);

    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(2);
    for (const alert of alerts) expect(stack()?.contains(alert)).toBe(true);
    for (const alert of alerts) expect(alert.className).not.toMatch(/\bfixed\b|\bz-\[/);
  });

  it("sits under a confirmation dialog", async () => {
    render(
      <>
        <BottomBanners />
        <ConfirmDialogHost />
      </>,
    );
    act(() => void confirmDialog({ title: "Close project", message: "Close it." }));

    const backdrop = (await screen.findByRole("dialog")).parentElement;
    expect(zIndex(stack())).toBeLessThan(zIndex(backdrop));
  });

  it("sits under a dialog and a context menu, which sit under a confirmation", () => {
    render(
      <>
        <BottomBanners />
        <Dialog labelledBy="t" onClose={() => {}} className="">
          <h2 id="t">Rename</h2>
        </Dialog>
        <ContextMenu x={0} y={0} items={[{ label: "Rename", onClick: () => {} }]} onClose={() => {}} />
        <ConfirmDialogHost />
      </>,
    );
    act(() => void confirmDialog({ title: "Close project", message: "Close it." }));

    const dialog = screen.getByRole("dialog", { name: "Rename" }).parentElement;
    const menu = screen.getByRole("menu").parentElement;
    const confirm = screen.getByRole("dialog", { name: "Close project" }).parentElement;
    for (const layer of [dialog, menu]) {
      expect(zIndex(stack())).toBeLessThan(zIndex(layer));
      expect(zIndex(layer)).toBeLessThan(zIndex(confirm));
    }
  });
});
