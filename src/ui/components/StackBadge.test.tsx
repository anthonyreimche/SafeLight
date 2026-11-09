// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { Profiler } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CatalogPhoto } from "@/catalog/types";
import { useCatalogStore } from "@/state/catalog-store";
import { useUIStore } from "@/state/ui-store";
import { useRegistry } from "@/extensions/registry";
import { NO_FILTER } from "@/modules/library/visible-photos";
import { StackBadge } from "./StackBadge";
import { Thumbnail } from "./Thumbnail";

function photo(id: string, over: Partial<CatalogPhoto> = {}): CatalogPhoto {
  return {
    id,
    filename: `${id}.NEF`,
    relPath: id,
    folder: "",
    directoryHandle: null,
    fileHandle: null,
    thumbnailBlob: null,
    thumbnailUrl: "blob:x",
    width: 6000,
    height: 4000,
    fileSize: 1000,
    mimeType: "image/x-nikon-nef",
    rating: 0,
    colorLabel: "none",
    flag: "none",
    rotation: 0,
    keywords: [],
    dateCreated: 0,
    dateImported: 0,
    exif: {},
    ...over,
  };
}

const photos = [photo("s1", { stackId: "S" }), photo("s2", { stackId: "S" }), photo("s3", { stackId: "S" }), photo("z")];

beforeEach(() => {
  useRegistry.setState({ gridFilters: {}, librarySorts: {} });
  useUIStore.setState({ sortField: "filename", sortDirection: "asc", filter: NO_FILTER, activeFolder: null, expandedStacks: new Set() });
  useCatalogStore.setState({ photos, selectedIds: new Set(), activePhotoId: null });
});

const cell = (p: CatalogPhoto, onClick = vi.fn()) =>
  render(<Thumbnail photo={p} selected={false} active={false} size={160} onClick={onClick} />);

describe("a stacked photo's cell", () => {
  it("shows the stack's size on its badge", () => {
    cell(photos[0]);
    expect(screen.getByRole("button", { name: "Expand stack of 3" }).textContent).toContain("3");
  });

  it("has no badge for a photo in no stack", () => {
    cell(photos[3]);
    expect(screen.queryByRole("button", { name: /stack of/ })).toBeNull();
  });

  it("expands and collapses the stack from its badge without selecting the cell", async () => {
    const onClick = vi.fn();
    cell(photos[0], onClick);

    await userEvent.click(screen.getByRole("button", { name: "Expand stack of 3" }));
    expect(useUIStore.getState().expandedStacks.has("S")).toBe(true);
    expect(await screen.findByRole("button", { name: "Collapse stack of 3" })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Collapse stack of 3" }));
    expect(useUIStore.getState().expandedStacks.has("S")).toBe(false);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("a stack badge's renders", () => {
  function countedBadge(photoId: string) {
    const commits = vi.fn();
    render(
      <Profiler id="badge" onRender={commits}>
        <StackBadge photoId={photoId} />
      </Profiler>,
    );
    return commits;
  }

  it("don't follow an unrelated change to the catalogue", () => {
    const commits = countedBadge("s1");
    expect(commits).toHaveBeenCalledTimes(1);

    act(() =>
      useCatalogStore.setState({
        photos: photos.map((p) => (p.id === "z" ? { ...p, rating: 4 } : p)),
      }),
    );
    act(() =>
      useCatalogStore.setState({
        photos: photos.map((p) => (p.id === "s2" ? { ...p, rating: 2 } : p)),
      }),
    );

    expect(commits).toHaveBeenCalledTimes(1);
  });

  it("follow a change to their own stack", () => {
    const commits = countedBadge("s1");

    act(() => useUIStore.getState().toggleStack("S"));
    expect(commits).toHaveBeenCalledTimes(2);

    act(() => useCatalogStore.setState({ photos: photos.filter((p) => p.id !== "s3") }));
    expect(commits).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("button", { name: "Collapse stack of 2" })).toBeTruthy();
  });

  it("don't follow another stack opening", () => {
    const other = [
      ...photos,
      photo("t1", { stackId: "T" }),
      photo("t2", { stackId: "T" }),
    ];
    useCatalogStore.setState({ photos: other });
    const commits = countedBadge("s1");

    act(() => useUIStore.getState().toggleStack("T"));

    expect(commits).toHaveBeenCalledTimes(1);
  });
});
