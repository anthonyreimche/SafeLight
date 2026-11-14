// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// catalog.json's text is built from the text each record had when it was last
// written: it must be the text JSON.stringify writes for the same catalogue.

import { afterEach, describe, expect, it, vi } from "vitest";
import { storedPhoto, type CatalogPhoto, type EditState, type StoredPhoto } from "@/catalog/types";
import { photo } from "@/catalog/stored-edit.fixtures";
import { catalogText, type CatalogData } from "./catalog-json";

const stored = (id: string): StoredPhoto => storedPhoto(photo(id));

const edit = (photoId: string, labels: string[]): EditState => ({
  photoId,
  stack: labels.map((label, i) => ({
    timestamp: i,
    label,
    params: { exposure: i * 0.5 } as unknown as EditState["stack"][number]["params"],
  })),
  currentIndex: labels.length - 1,
});

/** A catalogue with something of every kind a catalogue file holds. */
function fixture(): CatalogData {
  return {
    version: 1,
    id: "cat-1",
    photos: [stored("a"), stored("b")],
    edits: [edit("a", ["Original", "Exposure"])],
    removed: ["gone.jpg"],
    changed: {
      photos: { a: { rating: [5, "w:1"] }, b: { location: [3, "w:2"], rating: [4, "w:1"] } },
      edits: { a: [6, "w:1"] },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("catalogText", () => {
  it("writes what JSON.stringify writes for a catalogue", () => {
    const data = fixture();
    expect(catalogText(data)).toBe(JSON.stringify(data));
  });

  it("writes an empty catalogue", () => {
    const data: CatalogData = { version: 1, id: "", photos: [], edits: [], removed: [] };
    expect(catalogText(data)).toBe(JSON.stringify(data));
  });

  it("keeps keys it doesn't know where they stand, and leaves out what JSON leaves out", () => {
    const data = {
      future: { nested: [1, undefined, () => 1, "x"] },
      skipped: undefined,
      fn: () => 1,
      ...fixture(),
      at: new Date(Date.UTC(2026, 10, 12)),
      later: [undefined, null, -0, "naïve ✓   😀"],
    } as unknown as CatalogData;
    expect(catalogText(data)).toBe(JSON.stringify(data));
  });

  it("writes every field of a record the way JSON.stringify does", () => {
    const odd = {
      ...stored("odd"),
      keywords: ["a", "b"],
      exif: { focalLength: -0, lens: "Ünïcode \"quoted\"\n", cameraMake: undefined },
      shot: new Date(0),
      tags: [undefined, () => 1, { deep: [undefined] }],
      skipped: undefined,
    } as unknown as StoredPhoto;
    const snap = {
      ...edit("odd", ["Original"]).stack[0],
      paramBag: { "x.y": [1, undefined, -0], "x.z": undefined },
    };
    const data: CatalogData = {
      ...fixture(),
      photos: [odd],
      edits: [{ photoId: "odd", stack: [snap], currentIndex: 0, extra: undefined } as EditState],
    };
    expect(catalogText(data)).toBe(JSON.stringify(data));
  });

  it("writes array holes in the photos and edits as JSON does", () => {
    const data = {
      ...fixture(),
      photos: [stored("a"), undefined, null],
      edits: [undefined, { ...edit("a", ["One"]), stack: [undefined, edit("a", ["Two"]).stack[0]] }],
    } as unknown as CatalogData;
    expect(catalogText(data)).toBe(JSON.stringify(data));
  });

  it("orders stamp keys that look like array indices as JSON does", () => {
    const data: CatalogData = {
      ...fixture(),
      changed: { photos: { b: { rating: [1, "w"] }, "10": { rating: [2, "w"] }, "2": {} }, edits: {} },
    };
    expect(catalogText(data)).toBe(JSON.stringify(data));
  });

  it("leaves a held record's handles and preview out of its text", () => {
    const held: CatalogPhoto = {
      ...photo("held"),
      thumbnailBlob: new Blob(["preview"]),
      thumbnailUrl: "blob:preview",
    };
    const data: CatalogData = { ...fixture(), photos: [held, stored("kept")] };
    expect(catalogText(data)).toBe(
      JSON.stringify({ ...data, photos: [storedPhoto(held), stored("kept")] }),
    );
  });

  it("passes the array index to an edit's toJSON, as JSON.stringify does", () => {
    const keys: string[] = [];
    const data: CatalogData = {
      ...fixture(),
      edits: [{ ...edit("a", ["One"]), toJSON: (key: string) => (keys.push(key), edit("a", ["Two"])) } as EditState],
    };
    const text = catalogText(data);
    expect(keys).toEqual(["0"]);
    expect(text).toBe(JSON.stringify(data));
  });
});

describe("catalogText on a second save", () => {
  it("writes no record or history step it has written before", () => {
    const data = fixture();
    catalogText(data);
    const stringify = vi.spyOn(JSON, "stringify");

    const again = catalogText(data);

    const written = stringify.mock.calls.map(([value]) => value);
    expect(written).not.toContainEqual(expect.objectContaining({ relPath: expect.any(String) }));
    expect(written).not.toContainEqual(expect.objectContaining({ label: expect.any(String) }));
    stringify.mockRestore();
    expect(again).toBe(JSON.stringify(data));
  });

  it("writes a replaced record anew", () => {
    const data = fixture();
    catalogText(data);
    const rated = { ...stored("a"), rating: 5 };

    const text = catalogText({ ...data, photos: [rated, data.photos[1]] });

    expect(text).toBe(JSON.stringify({ ...data, photos: [rated, data.photos[1]] }));
    expect(text).toContain('"rating":5');
  });

  it("writes a new history step, and only that step", () => {
    const data = fixture();
    catalogText(data);
    const [first] = data.edits;
    const added = { ...first, stack: [...first.stack, edit("a", ["", "", "Contrast"]).stack[2]], currentIndex: 2 };
    const stringify = vi.spyOn(JSON, "stringify");

    const text = catalogText({ ...data, edits: [added] });

    const steps = stringify.mock.calls.filter(([value]) => typeof value === "object" && value !== null && "label" in value);
    expect(steps.map(([value]) => (value as { label: string }).label)).toEqual(["Contrast"]);
    stringify.mockRestore();
    expect(text).toBe(JSON.stringify({ ...data, edits: [added] }));
  });
});
