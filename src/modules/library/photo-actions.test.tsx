// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The photo right-click menu's "Update processing": it sits beside Paste settings
// and moves every targeted photo that is on the older processing, the whole
// selection when the clicked photo is part of it and just that photo otherwise.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Edits announce themselves to sibling windows; not under test here.
vi.mock("@/state/broadcast", () => ({
  broadcast: () => {},
  onBroadcast: () => () => {},
  WINDOW_ID: "test-window",
}));

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installMemoryStorage, photo, snapshot } from "@/catalog/stored-edit.fixtures";
import { setCatalogStorage } from "@/catalog/storage";
import { CURRENT_PROCESS_VERSION, LEGACY_PROCESS_VERSION } from "@/catalog/types";
import { useCatalogStore } from "@/state/catalog-store";
import { usePhotoActions } from "./photo-actions";

// A surface that lists photos: right-clicking its one cell targets `cell`.
function Surface({ cell }: { cell: string }) {
  const { onContextMenu, overlays } = usePhotoActions();
  return (
    <div>
      <button onContextMenu={(e) => onContextMenu(cell, e)}>cell</button>
      {overlays}
    </div>
  );
}

const olderEdit = (photoId: string) => ({
  photoId,
  currentIndex: 0,
  stack: [snapshot("Exposure", { exposure: 1, processVersion: LEGACY_PROCESS_VERSION })],
});

function openMenu(cell: string) {
  render(<Surface cell={cell} />);
  fireEvent.contextMenu(screen.getByText("cell"));
}

const menuLabels = () => screen.getAllByRole("menuitem").map((item) => item.textContent);

beforeEach(() => {
  useCatalogStore.setState({
    photos: ["a", "b", "c"].map((id) => photo(id)),
    selectedIds: new Set(["a", "b"]),
  });
});

afterEach(() => setCatalogStorage(null));

describe("photo menu: Update processing", () => {
  it("comes right after Paste settings", () => {
    openMenu("a");
    const labels = menuLabels();
    const paste = labels.findIndex((label) => label?.startsWith("Paste settings"));
    expect(paste).toBeGreaterThan(-1);
    expect(labels[paste + 1]).toBe("Update processing (2)");
  });

  it("updates every photo in the selection when the clicked one is part of it", async () => {
    const { written } = installMemoryStorage(olderEdit("a"), olderEdit("b"), olderEdit("c"));
    const user = userEvent.setup();
    openMenu("a");

    await user.click(screen.getByRole("menuitem", { name: "Update processing (2)" }));

    await waitFor(() => expect(written).toHaveLength(2));
    expect(written.map((state) => state.photoId).sort()).toEqual(["a", "b"]);
    for (const state of written) {
      const top = state.stack[state.currentIndex];
      expect(top.label).toBe("Update processing");
      expect(top.params.processVersion).toBe(CURRENT_PROCESS_VERSION);
    }
  });

  it("updates only the clicked photo when it is outside the selection", async () => {
    const { written } = installMemoryStorage(olderEdit("a"), olderEdit("b"), olderEdit("c"));
    const user = userEvent.setup();
    openMenu("c");

    await user.click(screen.getByRole("menuitem", { name: "Update processing" }));

    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0].photoId).toBe("c");
  });
});
