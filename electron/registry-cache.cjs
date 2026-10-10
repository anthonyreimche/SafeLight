// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Rules for the Extensions store's caches in main.cjs: when a cached search
// has expired, and when a fetched registry index is worth serving or caching.

"use strict";

/** Drops every entry of `map` ({ at, ... } values) at least `ttlMs` old at
 *  `now`. The search cache file holds one row per query ever run, so without
 *  this it only grows. */
function pruneExpired(map, ttlMs, now) {
  for (const [key, entry] of map)
    if (!(entry && typeof entry.at === "number" && now - entry.at < ttlMs)) map.delete(key);
  return map;
}

/** An index with no extensions (unpublished, or every row dropped as
 *  malformed) would blank the store; callers fall back to a live search. */
function usableIndex(items) {
  return Array.isArray(items) && items.length > 0;
}

module.exports = { pruneExpired, usableIndex };
