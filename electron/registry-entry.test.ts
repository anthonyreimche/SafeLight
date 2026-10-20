// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Reading the prebuilt registry index (registry-entry.cjs): each row's store
// fields are checked one by one and a bad one never drops the row; an absent
// categories field stays absent, because the store then reads the topics; the
// vocabulary keeps only well-formed entries; search also matches keywords and
// category labels.

import { describe, expect, it } from "vitest";
import {
  filterRegistry,
  normalizeRegistryEntry,
  parseVocabulary,
  readIndexCache,
} from "./registry-entry.cjs";

const row = (over: Record<string, unknown> = {}) => ({
  fullName: "acme/warp",
  description: "Warps.",
  stars: 3,
  updatedAt: "2026-01-01T00:00:00Z",
  topics: ["safelight-extension"],
  ...over,
});

describe("normalizeRegistryEntry", () => {
  it("drops a row without a valid repo", () => {
    expect(normalizeRegistryEntry({ fullName: "../x" })).toBeNull();
    expect(normalizeRegistryEntry(null)).toBeNull();
  });

  it("keeps the store fields the registry resolved", () => {
    const e = normalizeRegistryEntry(
      row({
        categories: ["detail", "tone"],
        type: "pipeline",
        keywords: ["liquify"],
        screenshots: ["https://e.com/a.png"],
        worksWith: ["acme/other"],
      }),
    );
    expect(e).toMatchObject({
      categories: ["detail", "tone"],
      type: "pipeline",
      keywords: ["liquify"],
      screenshots: ["https://e.com/a.png"],
      worksWith: ["acme/other"],
      source: "registry",
    });
  });

  it("leaves absent store fields absent", () => {
    const e = normalizeRegistryEntry(row());
    for (const key of ["categories", "type", "keywords", "screenshots", "worksWith"])
      expect(e).not.toHaveProperty(key);
  });

  it("keeps an empty category list: the registry found none", () => {
    expect(normalizeRegistryEntry(row({ categories: [] }))?.categories).toEqual([]);
  });

  it("drops bad values, repeats and overflow from each list, never the row", () => {
    const e = normalizeRegistryEntry(
      row({
        categories: ["Detail", "detail", "detail", 7, "tone", "color", "look"],
        type: "Bad Type",
        keywords: ["ok", "", "x".repeat(41), 3, ...Array.from({ length: 25 }, (_, i) => `k${i}`)],
        screenshots: ["http://e.com/a.png", "https://e.com/b.png", "javascript:alert(1)"],
        worksWith: ["acme/ok", "../etc", "no-slash"],
      }),
    );
    expect(e?.categories).toEqual(["detail", "tone", "color"]);
    expect(e?.type).toBeNull();
    expect(e?.keywords).toHaveLength(20);
    expect(e?.keywords?.[0]).toBe("ok");
    expect(e?.screenshots).toEqual(["https://e.com/b.png"]);
    expect(e?.worksWith).toEqual(["acme/ok"]);
  });

  it("falls back to the owner avatar for a missing thumbnail", () => {
    expect(normalizeRegistryEntry(row())?.thumbnail).toEqual({
      url: "https://github.com/acme.png?size=120",
      custom: false,
    });
  });
});

describe("parseVocabulary", () => {
  const body = {
    categories: [{ slug: "detail", label: "Detail and repair", description: "Repairs." }],
    types: [{ slug: "pipeline", label: "Processing" }],
  };

  it("reads the published categories and types", () => {
    expect(parseVocabulary(body)).toEqual(body);
  });

  it("drops malformed, repeated and reserved entries and keeps the rest", () => {
    expect(
      parseVocabulary({
        categories: [
          { slug: "detail", label: "Detail and repair", description: "Repairs." },
          { slug: "Bad", label: "Bad" },
          { slug: "detail", label: "Again" },
          { slug: "tone", label: "" },
          { slug: "other", label: "Other" },
          { slug: "home", label: "Home" },
          { slug: "look", label: "Looks" },
          "nope",
        ],
        types: [
          { slug: "panel", label: "Panel" },
          { slug: "detail", label: "Clash" },
          { slug: "wide", label: "y".repeat(25) },
        ],
      }),
    ).toEqual({
      categories: [
        { slug: "detail", label: "Detail and repair", description: "Repairs." },
        { slug: "look", label: "Looks", description: "" },
      ],
      types: [{ slug: "panel", label: "Panel" }],
    });
  });

  it("cuts a long description", () => {
    const v = parseVocabulary({ categories: [{ slug: "tone", label: "Tone", description: "x".repeat(200) }] });
    expect(v?.categories[0].description).toHaveLength(140);
    expect(v?.types).toEqual([]);
  });

  it("is null without a usable category", () => {
    expect(parseVocabulary(null)).toBeNull();
    expect(parseVocabulary([])).toBeNull();
    expect(parseVocabulary({ categories: [] })).toBeNull();
    expect(parseVocabulary({ categories: [{ slug: "Bad", label: "Bad" }] })).toBeNull();
  });
});

describe("readIndexCache", () => {
  it("reads a cache written before the vocabulary was cached with vocabulary null", () => {
    expect(readIndexCache({ at: 5, items: [] })).toEqual({ at: 5, items: [], vocabulary: null });
  });

  it("reads the cached vocabulary", () => {
    const vocabulary = { categories: [{ slug: "tone", label: "Tone", description: "" }], types: [] };
    expect(readIndexCache({ at: 5, items: [], vocabulary })?.vocabulary).toEqual(vocabulary);
  });

  it("rejects a malformed file", () => {
    expect(readIndexCache(null)).toBeNull();
    expect(readIndexCache({ at: "5", items: [] })).toBeNull();
    expect(readIndexCache({ at: 5 })).toBeNull();
  });
});

describe("filterRegistry", () => {
  const vocabulary = { categories: [{ slug: "color", label: "Colour", description: "" }], types: [] };
  const items = [
    {
      fullName: "acme/warp",
      description: "Push pixels",
      topics: ["safelight-extension"],
      keywords: ["liquify"],
      categories: ["detail"],
    },
    { fullName: "acme/grade", description: null, topics: ["safelight-color"], categories: ["color"] },
  ];
  const names = (list: { fullName: string }[]) => list.map((i) => i.fullName);

  it("returns everything for an empty query", () => {
    expect(filterRegistry(items, "  ", vocabulary)).toBe(items);
  });

  it("matches name, description and topics, any case", () => {
    expect(names(filterRegistry(items, "WARP", null))).toEqual(["acme/warp"]);
    expect(names(filterRegistry(items, "push", null))).toEqual(["acme/warp"]);
    expect(names(filterRegistry(items, "safelight-color", null))).toEqual(["acme/grade"]);
  });

  it("matches keywords", () => {
    expect(names(filterRegistry(items, "liquify", null))).toEqual(["acme/warp"]);
  });

  it("matches category labels when it has a vocabulary", () => {
    expect(names(filterRegistry(items, "colour", vocabulary))).toEqual(["acme/grade"]);
    expect(filterRegistry(items, "colour", null)).toEqual([]);
  });
});
