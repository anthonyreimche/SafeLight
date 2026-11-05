// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Preferences ▸ Previews ▸ Clear preview cache: it says "Cleared." only when
// the cache was cleared, and otherwise says how much was left behind.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  clear: (): Promise<{ failed: number }> => Promise.resolve({ failed: 0 }),
  native: false,
}));

vi.mock("@/raw/raw-cache", () => ({ clearRawCache: () => h.clear() }));
vi.mock("@/project/native-fs", () => ({
  isNativeFS: () => h.native,
  nativeFs: () => ({}),
}));

vi.mock("@/modules/library/import-photos", () => ({
  EAGER_CACHE_LIMIT: 1000,
  preDecodeRawsForCache: async () => {},
  rebuildThumbnails: async () => {},
}));
vi.mock("@/project/project-store", () => ({ projectPassSignal: () => undefined }));
vi.mock("./StoredCatalogsField", () => ({ StoredCatalogsField: () => null }));

const { PreviewsSection } = await import("./Previews");

const clickClear = () => fireEvent.click(screen.getByText("Clear preview cache"));

beforeEach(() => {
  h.clear = () => Promise.resolve({ failed: 0 });
  h.native = false;
});

describe("Catalogue location", () => {
  it("says it only applies to folders opened for the first time", () => {
    h.native = true;
    render(<PreviewsSection />);
    expect(screen.getByText(/Existing catalogues stay where they are/)).toBeTruthy();
  });
});

describe("Clear preview cache", () => {
  it("says it clears the cached previews of every project", () => {
    render(<PreviewsSection />);
    expect(screen.getByText(/clear the cached previews for all projects/)).toBeTruthy();
  });

  it("says Cleared when nothing was left behind", async () => {
    render(<PreviewsSection />);
    clickClear();
    expect(await screen.findByText("Cleared.")).toBeTruthy();
  });

  it("counts the previews it could not clear", async () => {
    h.clear = () => Promise.resolve({ failed: 3 });
    render(<PreviewsSection />);
    clickClear();
    expect(await screen.findByText("Couldn't clear 3 cached previews.")).toBeTruthy();
    expect(screen.queryByText("Cleared.")).toBeNull();
  });

  it("says so when the cache could not be reached", async () => {
    h.clear = () => Promise.reject(new Error("worker gone"));
    render(<PreviewsSection />);
    clickClear();
    expect(await screen.findByText("Couldn't clear the preview cache.")).toBeTruthy();
  });
});
