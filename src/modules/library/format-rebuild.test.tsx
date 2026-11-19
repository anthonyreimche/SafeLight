// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Reordering a format's decoders rebuilds the grid previews of that format's
// photos that show no edit, in the background, and a newer reorder of the same
// format takes over from one still running.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto } from "@/catalog/types";

const h = vi.hoisted(() => ({
  project: undefined as AbortSignal | undefined,
  runs: [] as { names: string[]; signal: AbortSignal | undefined; finish: () => void }[],
}));

vi.mock("@/project/project-store", () => ({ projectPassSignal: () => h.project }));
vi.mock("./import-passes", () => ({
  rebuildThumbnails: (photos: CatalogPhoto[], _p: unknown, _r: unknown, signal?: AbortSignal) =>
    new Promise<{ refetched: number }>((resolve) => {
      h.runs.push({
        names: photos.map((p) => p.filename),
        signal,
        finish: () => resolve({ refetched: 0 }),
      });
    }),
}));

const { rebuildFormatPreviews } = await import("./format-rebuild");
const { useCatalogStore } = await import("@/state/catalog-store");
const { updateSettings } = await import("@/state/settings-store");

function photo(filename: string, edited = false): CatalogPhoto {
  return {
    id: filename,
    filename,
    fileHandle: {},
    ...(edited ? { previewEdit: "rev" } : {}),
  } as unknown as CatalogPhoto;
}

beforeEach(() => {
  h.runs = [];
  h.project = undefined;
  updateSettings({ previewSource: "auto" });
  useCatalogStore.setState({
    photos: [photo("a.heic"), photo("b.HEIF"), photo("c.heic", true), photo("d.jpg"), photo("e.nef")],
  });
});

describe("rebuildFormatPreviews", () => {
  it("rebuilds the unedited photos of the format", () => {
    rebuildFormatPreviews("heif");
    expect(h.runs.map((r) => r.names)).toEqual([["a.heic", "b.HEIF"]]);
  });

  it("leaves RAW previews alone unless they are rendered", () => {
    rebuildFormatPreviews("nef");
    expect(h.runs).toEqual([]);
    updateSettings({ previewSource: "rendered" });
    rebuildFormatPreviews("nef");
    expect(h.runs.map((r) => r.names)).toEqual([["e.nef"]]);
  });

  it("starts nothing when no photo qualifies", () => {
    rebuildFormatPreviews("png");
    expect(h.runs).toEqual([]);
  });

  it("stops the run of the same format when a newer one starts", () => {
    rebuildFormatPreviews("heif");
    rebuildFormatPreviews("heif");
    expect(h.runs[0]?.signal?.aborted).toBe(true);
    expect(h.runs[1]?.signal?.aborted).toBe(false);
  });

  it("leaves a run of another format going", () => {
    updateSettings({ previewSource: "rendered" });
    rebuildFormatPreviews("heif");
    rebuildFormatPreviews("nef");
    expect(h.runs.map((r) => r.signal?.aborted)).toEqual([false, false]);
  });

  it("stops when the project is left", () => {
    const project = new AbortController();
    h.project = project.signal;
    rebuildFormatPreviews("heif");
    project.abort();
    expect(h.runs[0]?.signal?.aborted).toBe(true);
  });

  it("lets a finished run go, so a later one starts clean", async () => {
    rebuildFormatPreviews("heif");
    h.runs[0]?.finish();
    await Promise.resolve();
    rebuildFormatPreviews("heif");
    expect(h.runs[0]?.signal?.aborted).toBe(false);
  });
});
