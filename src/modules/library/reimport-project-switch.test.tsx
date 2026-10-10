// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The photo menu's "Re-import" runs on the open project and stops once the
// user leaves it: after a project switch it reads no more of its files, so it
// drops nothing from the next project's cache. The project's passes signal is
// faked; the re-import runs for real (this page has no Worker, so libraw
// declines every file at once).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  /** The open project's passes, as project-store hands them out. */
  project: new AbortController(),
  /** How often the menu asked for that signal. */
  asked: 0,
}));

// Edits announce themselves to sibling windows; not under test here.
vi.mock("@/state/broadcast", () => ({
  broadcast: () => {},
  onBroadcast: () => () => {},
  WINDOW_ID: "test-window",
}));

vi.mock("@/project/project-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/project/project-store")>()),
  projectPassSignal: () => {
    h.asked++;
    return h.project.signal;
  },
}));

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useCatalogStore } from "@/state/catalog-store";
import { usePhotoActions } from "./photo-actions";
import { rawPhoto } from "./raw-photo.test-support";

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

/** Each original read, by name. */
let reads: string[] = [];

/** Long enough for a re-import that kept going to read every file. */
const runOut = (): Promise<void> => new Promise((r) => setTimeout(r, 100));

beforeEach(() => {
  reads = [];
  h.project = new AbortController();
  h.asked = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const photos = ["A.NEF", "B.NEF", "C.NEF"].map((name) =>
    rawPhoto(name, {
      onRead: () => {
        reads.push(name);
        h.project.abort();
      },
    }),
  );
  useCatalogStore.setState({
    photos,
    selectedIds: new Set(photos.map((p) => p.id)),
  });
});

afterEach(() => {
  useCatalogStore.setState({ photos: [], selectedIds: new Set() });
  vi.restoreAllMocks();
});

describe("photo menu: Re-import across a project switch", () => {
  it("reads no further photo once the project is left", async () => {
    const user = userEvent.setup();
    render(<Surface cell="id:A.NEF" />);
    fireEvent.contextMenu(screen.getByText("cell"));

    await user.click(screen.getByRole("menuitem", { name: "Re-import (3)" }));
    await runOut();

    expect(h.asked).toBe(1);
    expect(reads).toEqual(["A.NEF"]);
  });
});
