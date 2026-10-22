// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Rules for reading the prebuilt registry index (registry.json) in main.cjs:
// one row into the ExtensionSearchResult shape the store renders, the category
// vocabulary published beside the rows, the index cache file, and the store's
// search filter. Everything here is remote data, so each field is checked on
// its own and a bad one is dropped without dropping the row.

"use strict";

const { validRepo } = require("./window-policy.cjs");
const { parseRegistryVersions } = require("./plugin-releases.cjs");

const SLUG = /^[a-z][a-z0-9-]{0,23}$/;
// The store's Browse keys: never category slugs.
const RESERVED = new Set(["home", "other"]);
const MAX_CATEGORIES = 3;
const MAX_KEYWORDS = 20;
const MAX_KEYWORD_LENGTH = 40;
const MAX_SCREENSHOTS = 6;
const MAX_WORKS_WITH = 6;
const MAX_LABEL = 24;
const MAX_DESCRIPTION = 140;

function avatarFor(repo, avatarUrl) {
  if (avatarUrl) return avatarUrl;
  const owner = String(repo).split("/")[0];
  return `https://github.com/${owner}.png?size=120`;
}

const uniqueWhere = (list, ok, max) =>
  [...new Set(list.filter((s) => typeof s === "string" && ok(s)))].slice(0, max);

// The fields the registry build adds per entry. A field the row doesn't carry
// stays absent: for `categories` that tells the store to read the topics,
// while [] means the registry found no category.
function storeFields(e) {
  const out = {};
  if (Array.isArray(e.categories))
    out.categories = uniqueWhere(e.categories, (s) => SLUG.test(s), MAX_CATEGORIES);
  if (e.type !== undefined)
    out.type = typeof e.type === "string" && SLUG.test(e.type) ? e.type : null;
  if (Array.isArray(e.keywords))
    out.keywords = uniqueWhere(
      e.keywords,
      (s) => s.length > 0 && s.length <= MAX_KEYWORD_LENGTH,
      MAX_KEYWORDS,
    );
  if (Array.isArray(e.screenshots))
    out.screenshots = uniqueWhere(e.screenshots, (s) => /^https:\/\//i.test(s), MAX_SCREENSHOTS);
  if (Array.isArray(e.worksWith)) out.worksWith = uniqueWhere(e.worksWith, validRepo, MAX_WORKS_WITH);
  return out;
}

// One registry.json row in the ExtensionSearchResult shape the renderer
// already consumes, or null when it has no valid repo. A row with no usable
// thumbnail falls back to the owner avatar, matching the live path.
function normalizeRegistryEntry(e) {
  if (!e || typeof e.fullName !== "string" || !validRepo(e.fullName)) return null;
  const thumb =
    e.thumbnail && typeof e.thumbnail.url === "string"
      ? { url: e.thumbnail.url, custom: !!e.thumbnail.custom }
      : null;
  const avatarUrl = typeof e.avatarUrl === "string" ? e.avatarUrl : null;
  return {
    fullName: e.fullName,
    description: typeof e.description === "string" ? e.description : null,
    stars: Number.isFinite(e.stars) ? e.stars : 0,
    createdAt: typeof e.createdAt === "string" ? e.createdAt : null,
    updatedAt: typeof e.updatedAt === "string" ? e.updatedAt : "",
    topics: Array.isArray(e.topics) ? e.topics.filter((t) => typeof t === "string") : [],
    avatarUrl,
    thumbnail: thumb || { url: avatarFor(e.fullName, avatarUrl), custom: false },
    ...storeFields(e),
    source: "registry",
    versions: parseRegistryVersions(e),
  };
}

const text = (v) => (typeof v === "string" ? v.trim() : "");
const list = (v) => (Array.isArray(v) ? v : []);

// One category or type with a valid slug no earlier entry took (categories
// and types share the slug space) and a label that fits, or null.
function vocabEntry(raw, taken) {
  if (!raw || typeof raw !== "object") return null;
  const label = text(raw.label);
  if (typeof raw.slug !== "string" || !SLUG.test(raw.slug) || RESERVED.has(raw.slug) || taken.has(raw.slug))
    return null;
  if (!label || label.length > MAX_LABEL) return null;
  taken.add(raw.slug);
  return { slug: raw.slug, label };
}

/** The categories and type badges published at the top of registry.json, or
 *  null when no category is usable (the store then keeps its fallback). */
function parseVocabulary(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const taken = new Set();
  const categories = list(body.categories).flatMap((c) => {
    const entry = vocabEntry(c, taken);
    return entry ? [{ ...entry, description: text(c.description).slice(0, MAX_DESCRIPTION) }] : [];
  });
  if (categories.length === 0) return null;
  const types = list(body.types).flatMap((t) => {
    const entry = vocabEntry(t, taken);
    return entry ? [entry] : [];
  });
  return { categories, types };
}

/** The registry index cache file as main.cjs writes it, or null. A file from
 *  before the vocabulary was cached reads with vocabulary null. */
function readIndexCache(raw) {
  if (!raw || typeof raw.at !== "number" || !Array.isArray(raw.items)) return null;
  return { at: raw.at, items: raw.items, vocabulary: parseVocabulary(raw.vocabulary) };
}

// Client-side query filter over the registry index: substring match on
// "owner/repo", description, topics, keywords and the labels of the entry's
// categories. Instant and offline: the index is already the whole catalog.
function filterRegistry(items, query, vocabulary) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return items;
  const labels = new Map((vocabulary ? vocabulary.categories : []).map((c) => [c.slug, c.label.toLowerCase()]));
  const has = (s) => String(s).toLowerCase().includes(q);
  return items.filter(
    (it) =>
      has(it.fullName) ||
      (it.description && has(it.description)) ||
      (it.topics || []).some(has) ||
      (it.keywords || []).some(has) ||
      (it.categories || []).some((slug) => (labels.get(slug) || "").includes(q)),
  );
}

module.exports = { avatarFor, normalizeRegistryEntry, parseVocabulary, readIndexCache, filterRegistry };
