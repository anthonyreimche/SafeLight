// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// How the store groups results: the registry's resolved categories when a
// result carries them (none included), its safelight-<slug> topics when it
// doesn't, and the type badge by the vocabulary's precedence.

import { describe, expect, it } from "vitest";
import {
  FALLBACK_VOCABULARY as V,
  OTHER,
  categoriesOf,
  categoryInfo,
  inCategory,
  moreFromAuthor,
  moreInCategory,
  typeOf,
  worksWithOf,
} from "./store-categories";

const slugs = (list: { slug: string }[]) => list.map((c) => c.slug);

describe("FALLBACK_VOCABULARY", () => {
  it("mirrors safelight-registry's categories.json", () => {
    expect(slugs(V.categories)).toEqual([
      "library",
      "metadata",
      "tone",
      "color",
      "look",
      "detail",
      "workflow",
      "export",
      "preset",
      "theme",
    ]);
    expect(V.categories.find((c) => c.slug === "color")?.label).toBe("Colour");
    expect(V.types).toEqual([
      { slug: "module", label: "Module" },
      { slug: "pipeline", label: "Processing" },
      { slug: "panel", label: "Panel" },
    ]);
  });
});

describe("categoriesOf", () => {
  it("keeps the registry's categories in order, dropping unknown slugs", () => {
    expect(slugs(categoriesOf({ categories: ["tone", "retired", "detail"] }, V))).toEqual(["tone", "detail"]);
  });

  it("treats a registry [] as no category, whatever the topics say", () => {
    expect(categoriesOf({ categories: [], topics: ["safelight-color"] }, V)).toEqual([]);
  });

  it("reads topics, in vocabulary order, when the result carries no categories", () => {
    expect(
      slugs(
        categoriesOf(
          { topics: ["safelight-theme", "safelight-panel", "safelight-color", "safelight-library", "safelight-look"] },
          V,
        ),
      ),
    ).toEqual(["library", "color", "look"]);
    expect(categoriesOf({ topics: ["safelight-panel"] }, V)).toEqual([]);
    expect(categoriesOf({}, V)).toEqual([]);
  });

  it("caps the registry's list at three", () => {
    expect(categoriesOf({ categories: ["tone", "color", "look", "detail"] }, V)).toHaveLength(3);
  });
});

describe("typeOf", () => {
  it("uses the registry's type when the vocabulary knows it", () => {
    expect(typeOf({ type: "pipeline", topics: ["safelight-panel"] }, V)?.label).toBe("Processing");
  });

  it("treats a registry null as no type, whatever the topics say", () => {
    expect(typeOf({ type: null, topics: ["safelight-panel"] }, V)).toBeNull();
  });

  it("reads topics by precedence when the type is absent or unknown", () => {
    expect(typeOf({ topics: ["safelight-panel", "safelight-module"] }, V)?.slug).toBe("module");
    expect(typeOf({ type: "widget", topics: ["safelight-panel"] }, V)?.slug).toBe("panel");
    expect(typeOf({ topics: ["safelight-theme"] }, V)).toBeNull();
  });
});

describe("inCategory and categoryInfo", () => {
  const results = [
    { fullName: "a", categories: ["detail"] },
    { fullName: "b", topics: ["safelight-detail", "safelight-tone"] },
    { fullName: "c", categories: [] },
    { fullName: "d", topics: ["safelight-panel"] },
  ];

  it("lists a category's members, registry and topic results alike", () => {
    expect(inCategory(results, "detail", V).map((r) => r.fullName)).toEqual(["a", "b"]);
    expect(inCategory(results, "tone", V).map((r) => r.fullName)).toEqual(["b"]);
  });

  it("lists results with no category under other", () => {
    expect(inCategory(results, "other", V).map((r) => r.fullName)).toEqual(["c", "d"]);
  });

  it("describes a known key and nothing else", () => {
    expect(categoryInfo("other", V)).toBe(OTHER);
    expect(categoryInfo("tone", V)?.label).toBe("Tone");
    expect(categoryInfo("home", V)).toBeNull();
    expect(categoryInfo("retired", V)).toBeNull();
  });
});

describe("related lists", () => {
  const results = [
    { fullName: "Acme/Warp", stars: 1, categories: ["detail"] },
    { fullName: "acme/gps", stars: 5, categories: ["metadata"] },
    { fullName: "acme/scopes", stars: 9, categories: ["color"] },
    { fullName: "other/denoise", stars: 3, categories: ["detail"] },
    { fullName: "other/moire", stars: 7, topics: ["safelight-detail"] },
  ];
  const names = (list: { fullName: string }[]) => list.map((r) => r.fullName);

  it("resolves Works with against the loaded results, in its order, any case", () => {
    expect(names(worksWithOf({ worksWith: ["other/denoise", "ACME/GPS", "gone/repo"] }, results))).toEqual([
      "other/denoise",
      "acme/gps",
    ]);
    expect(worksWithOf({}, results)).toEqual([]);
  });

  it("lists more from the same owner by stars, without itself", () => {
    expect(names(moreFromAuthor(results, "acme/warp", 12))).toEqual(["acme/scopes", "acme/gps"]);
    expect(names(moreFromAuthor(results, "acme/warp", 1))).toEqual(["acme/scopes"]);
  });

  it("lists more in a category by stars, without itself", () => {
    expect(names(moreInCategory(results, "acme/warp", "detail", V, 12))).toEqual(["other/moire", "other/denoise"]);
    expect(moreInCategory(results, "acme/warp", "tone", V, 12)).toEqual([]);
  });
});
