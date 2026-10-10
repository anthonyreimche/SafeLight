// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Deleting a folder from the Folders panel removes it from disk and its photos
// from the catalog, so it asks first through the in-app dialog, and a cancelled
// answer must leave both alone. The seams are the privileged bridge's
// fs.remove (stubbed before its one-shot claim) and the catalog store's
// removePhotos.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { photo } from "@/catalog/stored-edit.fixtures";
import { nativeDirectoryHandle } from "@/project/native-fs";
import { useProjectStore } from "@/project/project-store";
import { useCatalogStore } from "@/state/catalog-store";
import { popEscapeHandler } from "@/ui/escape-stack";
import { ConfirmDialogHost } from "@/ui/components/ConfirmDialog";
import { FoldersPanel } from "./LibrarySidebar";

const remove = vi.fn(async (_p: string): Promise<void> => {});
// privilegedFs() claims the bridge once per module registry, so the stub must
// exist before the first nativeFs() call and stay for the whole file.
vi.stubGlobal("safelightNative", {
  claimPrivileged: () => ({ fs: { remove }, updates: null }),
});

const removePhotos = vi.fn(async (_ids: string[]): Promise<void> => {});
const refreshTree = vi.fn(async (): Promise<void> => {});

beforeEach(() => {
  remove.mockClear();
  removePhotos.mockClear();
  useProjectStore.setState({
    root: nativeDirectoryHandle("D:/pics"),
    name: "pics",
    tree: {
      name: "pics",
      path: "",
      count: 0,
      children: [{ name: "trip", path: "trip", count: 1, children: [] }],
    },
    refreshTree,
  });
  useCatalogStore.setState({
    photos: [{ ...photo("a"), folder: "trip", relPath: "trip/a.NEF" }],
    removePhotos,
  });
});

// A card left open by a failed spec would stay queued for the next one.
afterEach(() => {
  for (let i = 0; i < 4; i++) act(() => void popEscapeHandler());
});

async function askToDelete(): Promise<HTMLElement> {
  render(
    <>
      <FoldersPanel />
      <ConfirmDialogHost />
    </>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Delete folder" }));
  return screen.findByRole("dialog", { name: "Delete folder" });
}

describe("Folders panel: delete folder", () => {
  it("deletes the folder and its photos once confirmed", async () => {
    const dialog = await askToDelete();
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith("D:/pics/trip"));
    expect(removePhotos).toHaveBeenCalledWith(["a"]);
  });

  it("cancelling deletes nothing", async () => {
    const dialog = await askToDelete();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(removePhotos).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});
