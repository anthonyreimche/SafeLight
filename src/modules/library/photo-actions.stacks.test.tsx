// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The photo right-click menu's Stack, Unstack and Select stack. Select stack
// takes the members a collapsed stack hides, which a click on its cover leaves
// out.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/state/broadcast", () => ({
  broadcast: () => {},
  onBroadcast: () => () => {},
  WINDOW_ID: "test-window",
}));

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installMemoryStorage, photo } from "@/catalog/stored-edit.fixtures";
import { setCatalogStorage } from "@/catalog/storage";
import { useCatalogStore } from "@/state/catalog-store";
import { useUIStore } from "@/state/ui-store";
import { useRegistry } from "@/extensions/registry";
import { NO_FILTER } from "./visible-photos";
import { usePhotoActions } from "./photo-actions";

function Surface({ cell }: { cell: string }) {
  const { onContextMenu, overlays } = usePhotoActions();
  return (
    <div>
      <button onContextMenu={(e) => onContextMenu(cell, e)}>cell</button>
      {overlays}
    </div>
  );
}

function openMenu(cell: string) {
  render(<Surface cell={cell} />);
  fireEvent.contextMenu(screen.getByText("cell"));
}

const item = (name: RegExp | string) => screen.getByRole("menuitem", { name });
const disabled = (name: RegExp | string) => item(name).hasAttribute("disabled") || item(name).getAttribute("aria-disabled") === "true";

beforeEach(() => {
  installMemoryStorage();
  useRegistry.setState({ gridFilters: {}, librarySorts: {} });
  useUIStore.setState({ sortField: "filename", sortDirection: "asc", filter: NO_FILTER, activeFolder: null, expandedStacks: new Set() });
});

afterEach(() => {
  cleanup();
  setCatalogStorage(null);
});

describe("photo menu: stacks", () => {
  it("stacks the selection with the clicked photo as its cover", async () => {
    useCatalogStore.setState({
      photos: ["a", "b", "c"].map((id) => photo(id)),
      selectedIds: new Set(["a", "b"]),
    });
    openMenu("b");

    await userEvent.setup().click(item("Stack (2)"));

    await waitFor(() => expect(useCatalogStore.getState().photos[0].stackId).toBeDefined());
    const [a, b, c] = useCatalogStore.getState().photos;
    expect(a.stackId).toBe(b.stackId);
    expect(b.stackCover).toBe(true);
    expect(a.stackCover).toBeUndefined();
    expect(c.stackId).toBeUndefined();
  });

  it("can't stack a single photo, or unstack photos in no stack", () => {
    useCatalogStore.setState({ photos: [photo("a"), photo("b")], selectedIds: new Set(["a"]) });
    openMenu("a");

    expect(disabled("Stack")).toBe(true);
    expect(disabled("Unstack")).toBe(true);
    expect(disabled("Select stack")).toBe(true);
  });

  it("selects every member of the stack, the ones a collapsed stack hides too", async () => {
    useCatalogStore.setState({
      photos: [
        photo("a"),
        { ...photo("s1"), stackId: "S" },
        { ...photo("s2"), stackId: "S" },
        { ...photo("s3"), stackId: "S" },
      ],
      selectedIds: new Set(["s1"]),
    });
    openMenu("s1");

    await userEvent.setup().click(item("Select stack"));

    expect([...useCatalogStore.getState().selectedIds].sort()).toEqual(["s1", "s2", "s3"]);
  });

  it("unstacks only the photos acted on in an expanded stack", async () => {
    useUIStore.setState({ expandedStacks: new Set(["S"]) });
    useCatalogStore.setState({
      photos: ["s1", "s2", "s3"].map((id) => ({ ...photo(id), stackId: "S" })),
      selectedIds: new Set(["s1"]),
    });
    openMenu("s1");

    await userEvent.setup().click(item("Unstack"));

    await waitFor(() => expect(useCatalogStore.getState().photos[0].stackId).toBeUndefined());
    expect(useCatalogStore.getState().photos.map((p) => p.stackId)).toEqual([undefined, "S", "S"]);
  });

  it("unstacks every member when the selected cover stands for a collapsed stack", async () => {
    useCatalogStore.setState({
      photos: [photo("a"), ...["s1", "s2", "s3"].map((id) => ({ ...photo(id), stackId: "S" }))],
      selectedIds: new Set(["s1"]),
    });
    openMenu("s1");

    await userEvent.setup().click(item("Unstack"));

    await waitFor(() => expect(useCatalogStore.getState().photos[1].stackId).toBeUndefined());
    expect(useCatalogStore.getState().photos.map((p) => p.stackId)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("enables Unstack when the selection joins a stack while the menu is open", () => {
    useCatalogStore.setState({ photos: [photo("a"), photo("b")], selectedIds: new Set(["a"]) });
    openMenu("a");
    expect(disabled("Unstack")).toBe(true);

    act(() =>
      useCatalogStore.setState({
        photos: [photo("a"), photo("b")].map((p) => ({ ...p, stackId: "S" })),
      }),
    );

    expect(disabled("Unstack")).toBe(false);
  });
});
