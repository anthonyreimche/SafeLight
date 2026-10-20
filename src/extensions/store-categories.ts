// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// How the Extensions store groups results: by the category slugs the registry
// build resolved, or, for live-search results and older indexes that carry
// none, by the result's safelight-<slug> topics. The vocabulary comes from the
// registry index; FALLBACK_VOCABULARY is a copy of safelight-registry's
// categories.json for when it can't be read, so keep the two in step.

import type { ExtensionSearchResult, StoreCategory, StoreType, StoreVocabulary } from "./types";

export const MAX_CATEGORIES = 3;

export const FALLBACK_VOCABULARY: StoreVocabulary = {
  categories: [
    { slug: "library", label: "Library", description: "Collections, sorting, duplicates and other ways to organise and find photos." },
    { slug: "metadata", label: "Metadata", description: "Keywords, EXIF and XMP tools, and where your photos were taken." },
    { slug: "tone", label: "Tone", description: "Levels, local contrast and HDR: shape brightness and contrast." },
    { slug: "color", label: "Colour", description: "Colour editors, grading tools and scopes to check the result." },
    { slug: "look", label: "Looks", description: "Film simulation, alternative renderings and camera-matched looks." },
    { slug: "detail", label: "Detail and repair", description: "Noise, lens faults, moiré, red eye, warping and other repairs." },
    { slug: "workflow", label: "Workflow", description: "Faster culling and editing, batch work, comparisons and navigation." },
    { slug: "export", label: "Export and sharing", description: "Export formats, web galleries, print layouts and watermarks." },
    { slug: "preset", label: "Presets", description: "Import and manage presets, including Lightroom .xmp and .lrtemplate files." },
    { slug: "theme", label: "Themes and interface", description: "Themes, cursors, control styles and other changes to how Safelight looks." },
  ],
  types: [
    { slug: "module", label: "Module" },
    { slug: "pipeline", label: "Processing" },
    { slug: "panel", label: "Panel" },
  ],
};

/** The Browse list of results with no category. */
export const OTHER: StoreCategory = { slug: "other", label: "Other", description: "" };

const topicSet = (topics?: string[]) => new Set((topics ?? []).map((t) => t.toLowerCase()));

/** A result's categories, in order. A registry result keeps what the build
 *  resolved, even none; a result without that field goes by its topics. */
export function categoriesOf(
  result: Pick<ExtensionSearchResult, "categories" | "topics">,
  vocab: StoreVocabulary,
): StoreCategory[] {
  if (result.categories) {
    const bySlug = new Map(vocab.categories.map((c) => [c.slug, c]));
    return result.categories.flatMap((s) => bySlug.get(s) ?? []).slice(0, MAX_CATEGORIES);
  }
  const topics = topicSet(result.topics);
  return vocab.categories.filter((c) => topics.has(`safelight-${c.slug}`)).slice(0, MAX_CATEGORIES);
}

/** A result's type badge: the registry's when the vocabulary knows it (null
 *  meaning none), else the first type by precedence whose topic it carries. */
export function typeOf(
  result: Pick<ExtensionSearchResult, "type" | "topics">,
  vocab: StoreVocabulary,
): StoreType | null {
  if (result.type === null) return null;
  if (typeof result.type === "string") {
    const known = vocab.types.find((t) => t.slug === result.type);
    if (known) return known;
  }
  const topics = topicSet(result.topics);
  return vocab.types.find((t) => topics.has(`safelight-${t.slug}`)) ?? null;
}

/** The results in one category, or with none for "other". */
export function inCategory<T extends Pick<ExtensionSearchResult, "categories" | "topics">>(
  results: T[],
  key: string,
  vocab: StoreVocabulary,
): T[] {
  return results.filter((r) => {
    const cats = categoriesOf(r, vocab);
    return key === OTHER.slug ? cats.length === 0 : cats.some((c) => c.slug === key);
  });
}

/** The page header for a Browse key: OTHER, a known category, or null. */
export function categoryInfo(key: string, vocab: StoreVocabulary): StoreCategory | null {
  if (key === OTHER.slug) return OTHER;
  return vocab.categories.find((c) => c.slug === key) ?? null;
}
