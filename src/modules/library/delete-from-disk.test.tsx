// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The confirm-and-report flow around the app's most destructive action.
// Native confirm/alert suspend Electron's renderer and can desync window focus
// (electron#31917), so confirmAndDeleteFromDisk must run its confirmation and
// its failure report through the in-app dialog — these tests pin that neither
// window.confirm nor window.alert is ever invoked. The seam is the privileged
// bridge (claimPrivileged → fs.trash), stubbed before its one-shot boot claim;
// pure trash mechanics (sidecars, copies, cache purge) stay in
// delete-from-disk.test.ts.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { photo } from "@/catalog/stored-edit.fixtures";
import { useCatalogStore } from "@/state/catalog-store";
import { nativeDirectoryHandle } from "@/project/native-fs";
import { popEscapeHandler } from "@/ui/escape-stack";
import { ConfirmDialogHost } from "@/ui/components/ConfirmDialog";
import { confirmAndDeleteFromDisk, trashLabel } from "./delete-from-disk";

const trash = vi.fn(async (_p: string): Promise<void> => {});
const exists = vi.fn(async (_p: string): Promise<boolean> => false);
// privilegedFs() claims the bridge once per module registry, so the stub must
// exist before the first nativeFs() call and stay for the whole file.
vi.stubGlobal("safelightNative", {
  claimPrivileged: () => ({ fs: { trash, exists }, updates: null }),
});

const removePhotos = vi.fn(async (_ids: string[]): Promise<void> => {});
let confirmSpy: MockInstance<Window["confirm"]>;
let alertSpy: MockInstance<Window["alert"]>;

async function seedPhoto(id: string): Promise<void> {
  const fileHandle = await nativeDirectoryHandle("D:/pics").getFileHandle(
    `${id}.NEF`,
  );
  useCatalogStore.setState({
    photos: [{ ...photo(id), fileSize: 25_000_000, fileHandle }],
    removePhotos,
  });
}

beforeEach(async () => {
  trash.mockClear().mockResolvedValue(undefined);
  exists.mockClear().mockResolvedValue(false);
  removePhotos.mockClear();
  await seedPhoto("a");
  // Answering "yes" keeps a legacy native path observable rather than crashing
  // on jsdom's unimplemented confirm — the assertion is that it never runs.
  confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
  alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
});

// A card left open by a failed spec would hold the in-flight guard for the
// rest of the file; closing it through the escape stack releases it.
afterEach(() => {
  for (let i = 0; i < 4; i++) act(() => void popEscapeHandler());
});

describe("confirmAndDeleteFromDisk", () => {
  it("confirms through the in-app danger dialog, then trashes", async () => {
    const user = userEvent.setup();
    render(<ConfirmDialogHost />);
    let flow!: Promise<void>;
    act(() => {
      flow = confirmAndDeleteFromDisk(["a"]);
    });

    const dialog = await screen.findByRole("dialog", { name: "Delete from disk" });
    expect(dialog.textContent).toContain(`Move 1 photo to the ${trashLabel()}`);
    const confirmButton = within(dialog).getByRole("button", {
      name: `Move to ${trashLabel()}`,
    });
    expect(confirmButton.className).toContain("var(--color-label-red)");

    await user.click(confirmButton);
    await flow;
    expect(trash).toHaveBeenCalledWith("D:/pics/a.NEF");
    expect(removePhotos).toHaveBeenCalledWith(["a"]);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("cancelling leaves the files and the catalog untouched", async () => {
    const user = userEvent.setup();
    render(<ConfirmDialogHost />);
    let flow!: Promise<void>;
    act(() => {
      flow = confirmAndDeleteFromDisk(["a"]);
    });

    await screen.findByRole("dialog", { name: "Delete from disk" });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await flow;
    expect(trash).not.toHaveBeenCalled();
    expect(removePhotos).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("opens one confirmation at a time and asks again once it's answered", async () => {
    const user = userEvent.setup();
    render(<ConfirmDialogHost />);
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = confirmAndDeleteFromDisk(["a"]);
      second = confirmAndDeleteFromDisk(["a"]);
    });

    await screen.findByRole("dialog", { name: "Delete from disk" });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await first;
    // A queued second card would surface here.
    expect(screen.queryByRole("dialog")).toBeNull();
    await second;
    expect(trash).not.toHaveBeenCalled();

    let third!: Promise<void>;
    act(() => {
      third = confirmAndDeleteFromDisk(["a"]);
    });
    await screen.findByRole("dialog", { name: "Delete from disk" });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await third;
  });

  it("reports failures through the in-app alert, never window.alert", async () => {
    trash.mockRejectedValue(new Error("EBUSY: locked"));
    const user = userEvent.setup();
    render(<ConfirmDialogHost />);
    let flow!: Promise<void>;
    act(() => {
      flow = confirmAndDeleteFromDisk(["a"]);
    });

    await screen.findByRole("dialog", { name: "Delete from disk" });
    await user.click(
      screen.getByRole("button", { name: `Move to ${trashLabel()}` }),
    );

    const report = await screen.findByRole("alertdialog", {
      name: "Delete from disk",
    });
    expect(report.textContent).toContain("a.NEF");
    expect(report.textContent).toContain("EBUSY: locked");
    await user.click(within(report).getByRole("button", { name: "OK" }));
    await flow;
    expect(removePhotos).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
  });
});
