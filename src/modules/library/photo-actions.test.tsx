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

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CALLBACK_FAILURE_LIMIT, useCallbackFailures } from "@/extensions/guard";
import userEvent from "@testing-library/user-event";
import { installMemoryStorage, photo, snapshot } from "@/catalog/stored-edit.fixtures";
import { setCatalogStorage } from "@/catalog/storage";
import { CURRENT_PROCESS_VERSION, LEGACY_PROCESS_VERSION } from "@/catalog/types";
import { useCatalogStore } from "@/state/catalog-store";
import { ConfirmDialogHost } from "@/ui/components/ConfirmDialog";
import { registerGridMenuItem, unregisterExtension } from "@/extensions/registry";
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

describe("photo menu: single-photo items with several photos selected", () => {
  it("stay enabled and act on the right-clicked photo", async () => {
    const user = userEvent.setup();
    openMenu("b");

    for (const name of ["Open in Develop", "Rename…", "Copy settings…"]) {
      expect((screen.getByRole("menuitem", { name }) as HTMLButtonElement).disabled).toBe(false);
    }
    await user.click(screen.getByRole("menuitem", { name: "Open in Develop" }));
    expect(useCatalogStore.getState().activePhotoId).toBe("b");
  });

  it("rename opens for the right-clicked photo", async () => {
    useCatalogStore.setState({
      photos: ["a", "b", "c"].map((id) => ({ ...photo(id), filename: `${id}-shot.NEF` })),
    });
    const user = userEvent.setup();
    openMenu("b");

    await user.click(screen.getByRole("menuitem", { name: "Rename…" }));

    expect((screen.getByRole("textbox", { name: "Rename photo" }) as HTMLInputElement).value).toBe("b-shot");
  });

  it("leave the multi-photo items on the whole selection", () => {
    openMenu("b");
    expect(menuLabels()).toContain("Update processing (2)");
  });
});

describe("photo actions: re-rendering", () => {
  it("a field update on another photo does not re-render the host", () => {
    let renders = 0;
    function Counted() {
      renders++;
      usePhotoActions();
      return null;
    }
    render(<Counted />);
    const before = renders;
    act(() => {
      useCatalogStore.setState({
        photos: useCatalogStore.getState().photos.map((p) => (p.id === "c" ? { ...p, rating: 4 } : p)),
      });
    });
    expect(renders).toBe(before);
  });
});

describe("photo actions: copy settings from the keyboard", () => {
  it("the shortcut's event opens the checklist for the named photo", async () => {
    const { written } = installMemoryStorage(olderEdit("a"));
    void written;
    render(<Surface cell="a" />);
    act(() => {
      window.dispatchEvent(new CustomEvent("sl-copy-settings", { detail: { id: "a" } }));
    });
    await screen.findByRole("dialog");
  });
});

describe("photo menu: extension items", () => {
  const boom = () => {
    throw new Error("broken extension");
  };
  afterEach(() => unregisterExtension("acme.broken"));

  it("survive an item whose label, enabled and onClick throw", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    registerGridMenuItem("acme.broken", { id: "acme.broken.item", label: boom, enabled: boom, onClick: boom });
    const user = userEvent.setup();
    openMenu("a");

    expect(menuLabels()).toContain("Update processing (2)");
    const item = screen.getByRole("menuitem", { name: "acme.broken.item" }) as HTMLButtonElement;
    expect(item.disabled).toBe(true);
    await user.click(item);
  });

  it("are switched off after repeated throws and listed against their extension", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const label = vi.fn(boom);
    registerGridMenuItem("acme.broken", { id: "acme.broken.item", label, onClick: () => {} });
    for (let i = 0; i <= CALLBACK_FAILURE_LIMIT; i++) {
      openMenu("a");
      cleanup();
    }
    expect(label).toHaveBeenCalledTimes(CALLBACK_FAILURE_LIMIT);
    expect(useCallbackFailures.getState()["acme.broken"]?.kind).toBe("grid menu item label");
  });

  it("run onClick without crashing when it throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    registerGridMenuItem("acme.broken", { id: "acme.broken.item", label: "Broken", onClick: boom });
    const user = userEvent.setup();
    openMenu("a");

    await user.click(screen.getByRole("menuitem", { name: "Broken" }));
    expect(screen.getByText("cell")).toBeTruthy();
  });
});

describe("photo menu: Remove", () => {
  it("says the files stay on disk while the photos and their edits leave the catalog", async () => {
    const removePhotos = vi.fn(async (_ids: string[]): Promise<void> => {});
    useCatalogStore.setState({ removePhotos });
    const user = userEvent.setup();
    render(<ConfirmDialogHost />);
    openMenu("a");

    await user.click(screen.getByRole("menuitem", { name: "Remove (2)" }));

    const dialog = screen.getByRole("dialog", { name: "Remove from catalog" });
    expect(dialog.textContent).toMatch(/original files on disk won't be deleted/);
    expect(dialog.textContent).toMatch(/edits, ratings and labels/);
    expect(dialog.textContent).not.toMatch(/reappear/);
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(removePhotos).toHaveBeenCalledWith(["a", "b"]);
  });
});
