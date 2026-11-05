// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Preferences ▸ Stored catalogues: two cards that mount at the same drive letter
// keep separate catalogues, so each row has to say which card it belongs to before
// anyone deletes one.

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ExternalCatalogEntry } from "@/extensions/types";

const entries: ExternalCatalogEntry[] = [
  {
    name: "E-1a2b",
    path: "C:/catalogs/E-1a2b",
    sourcePath: "E:\\",
    bytes: 2048,
    createdAt: 0,
    mtimeMs: 0,
    photoCount: 412,
    lastOpenedAt: Date.UTC(2026, 9, 30),
    sampleNames: ["IMG_0001.CR3", "IMG_0002.CR3", "IMG_0003.CR3"],
  },
  {
    name: "E-1a2b-2",
    path: "C:/catalogs/E-1a2b-2",
    sourcePath: "E:\\",
    bytes: 1024,
    createdAt: 0,
    mtimeMs: 0,
    photoCount: 1,
    lastOpenedAt: null,
    sampleNames: ["DSC_9001.NEF"],
  },
];

vi.mock("@/project/native-fs", () => ({
  nativeFs: () => ({
    listExternalCatalogs: () => Promise.resolve(entries),
    reveal: () => Promise.resolve(),
    remove: () => Promise.resolve(),
  }),
}));

const { StoredCatalogsField } = await import("./StoredCatalogsField");

describe("Stored catalogues", () => {
  it("tells two catalogues of one drive apart by their photos", async () => {
    render(<StoredCatalogsField />);
    expect(await screen.findByText(/412 photos/)).toBeTruthy();
    expect(screen.getByText(/IMG_0001\.CR3, IMG_0002\.CR3, IMG_0003\.CR3/)).toBeTruthy();
    expect(screen.getByText(/1 photo\b/)).toBeTruthy();
    expect(screen.getByText(/DSC_9001\.NEF/)).toBeTruthy();
  });

  it("says when each was last opened", async () => {
    render(<StoredCatalogsField />);
    await screen.findByText(/412 photos/);
    const opened = new Date(Date.UTC(2026, 9, 30)).toLocaleDateString();
    expect(screen.getByText(new RegExp(`opened ${opened.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`))).toBeTruthy();
  });
});
