// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it } from "vitest";
import type { CatalogPhoto } from "./types";
import { collapseStacks, stackCoverId, stackOf } from "./stacks";

function photo(id: string, over: Partial<CatalogPhoto> = {}): CatalogPhoto {
  return {
    id,
    filename: `${id}.NEF`,
    relPath: id,
    folder: "",
    directoryHandle: null,
    fileHandle: null,
    thumbnailBlob: null,
    thumbnailUrl: null,
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

const ids = (list: readonly CatalogPhoto[]) => list.map((p) => p.id);
const none: ReadonlySet<string> = new Set();

describe("which member covers a stack", () => {
  it("is the first member in order when none is marked", () => {
    expect(stackCoverId([photo("c"), photo("a"), photo("b")])).toBe("c");
  });

  it("is the marked member", () => {
    expect(stackCoverId([photo("a"), photo("b", { stackCover: true }), photo("c")])).toBe("b");
  });

  it("is the lowest id when two windows marked different covers", () => {
    const members = [photo("b", { stackCover: true }), photo("a"), photo("c", { stackCover: true })];
    expect(stackCoverId(members)).toBe("b");
    expect(stackCoverId([...members].reverse())).toBe("b");
  });
});

describe("collapseStacks", () => {
  it("hands back the list it was given when nothing is stacked", () => {
    const list = [photo("a"), photo("b")];
    const out = collapseStacks(list, none);
    expect(out.list).toBe(list);
    expect(out.stacks.size).toBe(0);
  });

  it("shows a collapsed stack as its cover alone, in the slot of its first member", () => {
    const list = [
      photo("a"),
      photo("s1", { stackId: "S" }),
      photo("b"),
      photo("s2", { stackId: "S", stackCover: true }),
      photo("s3", { stackId: "S" }),
      photo("c"),
    ];
    const out = collapseStacks(list, none);
    expect(ids(out.list)).toEqual(["a", "s2", "b", "c"]);
    expect(out.stacks.get("s2")).toEqual({ stackId: "S", size: 3, coverId: "s2", expanded: false });
  });

  it("shows every member of an expanded stack, in order", () => {
    const list = [photo("s1", { stackId: "S" }), photo("a"), photo("s2", { stackId: "S" })];
    const out = collapseStacks(list, new Set(["S"]));
    expect(ids(out.list)).toEqual(["s1", "a", "s2"]);
    expect(out.stacks.get("s1")?.expanded).toBe(true);
    expect(out.stacks.get("s2")?.coverId).toBe("s1");
  });

  it("treats a lone member of a stack as an ordinary photo", () => {
    const list = [photo("a", { stackId: "S", stackCover: true }), photo("b")];
    const out = collapseStacks(list, none);
    expect(ids(out.list)).toEqual(["a", "b"]);
    expect(out.stacks.size).toBe(0);
  });

  it("keeps stacks apart", () => {
    const list = [
      photo("a", { stackId: "X" }),
      photo("b", { stackId: "Y" }),
      photo("c", { stackId: "X" }),
      photo("d", { stackId: "Y" }),
    ];
    expect(ids(collapseStacks(list, new Set(["Y"])).list)).toEqual(["a", "b", "d"]);
  });

  it("covers with one photo when two members are marked", () => {
    const list = [
      photo("s2", { stackId: "S", stackCover: true }),
      photo("s1", { stackId: "S", stackCover: true }),
    ];
    expect(ids(collapseStacks(list, none).list)).toEqual(["s1"]);
  });
});

describe("stackOf", () => {
  const photos = [
    photo("a"),
    photo("s1", { stackId: "S" }),
    photo("s2", { stackId: "S", stackCover: true }),
  ];

  it("names the members in catalogue order and the cover", () => {
    expect(stackOf(photos, "s1")).toEqual({ stackId: "S", ids: ["s1", "s2"], cover: "s2" });
  });

  it("is null for a photo in no stack, and for a stack of one", () => {
    expect(stackOf(photos, "a")).toBeNull();
    expect(stackOf(photos.slice(0, 2), "s1")).toBeNull();
    expect(stackOf(photos, "missing")).toBeNull();
  });
});
