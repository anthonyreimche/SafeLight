// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Discover official extensions on GitHub by topic (default
// "safelight-extension"; configurable in Preferences ▸ Extensions). Runs in the
// main process so the renderer's COOP/COEP isolation never gets in the way.
//
// Results are cached (memory + disk) per (topic, query) with a short TTL. The
// default browse grid (empty query) is the first thing the store fetches on every
// open, so serving it from a warm cache makes re-opens instant and spares the
// unauthenticated 60/hr GitHub Search budget. On rate-limit / network failure we
// fall back to the cached payload while one is still held, even past its TTL,
// rather than surfacing an error.

const fs = require("node:fs");
const path = require("node:path");
const { pruneExpired, usableIndex } = require("../registry-cache.cjs");
const { filterRegistry } = require("../registry-entry.cjs");
const { DEFAULT_EXT_TOPIC } = require("./registry.cjs");

const SEARCH_TTL_MS = 15 * 60 * 1000; // results turn over slowly; 15 min is plenty

/**
 * @param {{
 *   net: { fetch: typeof fetch },
 *   userData: () => string,
 *   fileWriter: { write(file: string, data: string): Promise<void> },
 *   registry: {
 *     fetchRegistryIndex(force?: boolean): Promise<Array<{ versions?: unknown }> | null>,
 *     cachedVocabulary(): unknown,
 *   },
 *   cachedThumbnail: (repo: string, avatarUrl: string | null) => { url: string, custom: boolean },
 * }} deps
 */
function createSearch({ net, userData, fileWriter, registry, cachedThumbnail }) {
  const searchCache = new Map(); // `${topic}\n${query}` -> { at, items }
  const searchCacheFile = () => path.join(userData(), "search-cache.json");
  let searchCacheLoaded = false;

  function loadSearchDisk() {
    if (searchCacheLoaded) return;
    searchCacheLoaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(searchCacheFile(), "utf8"));
      if (raw && typeof raw === "object")
        for (const [k, v] of Object.entries(raw))
          if (v && typeof v.at === "number" && Array.isArray(v.items))
            searchCache.set(k, { at: v.at, items: v.items });
    } catch {}
    // One row per query ever run: expired rows go on load and on write, or the
    // file only grows across sessions.
    pruneExpired(searchCache, SEARCH_TTL_MS, Date.now());
  }

  let searchWriteTimer = null;
  function persistSearchDisk() {
    pruneExpired(searchCache, SEARCH_TTL_MS, Date.now());
    if (searchWriteTimer) return;
    searchWriteTimer = setTimeout(() => {
      searchWriteTimer = null;
      fileWriter
        .write(searchCacheFile(), JSON.stringify(Object.fromEntries(searchCache)))
        .catch(() => {});
    }, 1000);
    if (searchWriteTimer.unref) searchWriteTimer.unref();
  }

  // Re-resolve each item's thumbnail from the (now-warm) icon/og caches: a cached
  // search payload may pre-date a thumbnail that has since been resolved, so a warm
  // re-open (or a stale-cache fallback) paints real icons with no round-trips.
  // cachedThumbnail is a purely local lookup, so this stays offline-safe.
  function withFreshThumbs(items) {
    return items.map((it) => ({
      ...it,
      thumbnail: cachedThumbnail(it.fullName, it.avatarUrl || null),
    }));
  }

  async function searchExtensionsLive(query, topic, force = false) {
    const t = String(topic || DEFAULT_EXT_TOPIC).trim();
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(t)) throw new Error("Bad extension topic");
    const q = [String(query || "").trim(), `topic:${t}`]
      .filter(Boolean)
      .join(" ");
    loadSearchDisk();
    const key = `${t}\n${String(query || "").trim()}`;
    const hit = searchCache.get(key);
    if (!force && hit && Date.now() - hit.at < SEARCH_TTL_MS)
      return withFreshThumbs(hit.items);
    let res;
    try {
      res = await net.fetch(
        `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=100`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "Safelight",
          },
          signal: AbortSignal.timeout(10000),
        }
      );
    } catch (e) {
      if (hit) return withFreshThumbs(hit.items); // network hiccup — serve last-good rather than fail
      throw e;
    }
    if (res.status === 403 || res.status === 429) {
      if (hit) return withFreshThumbs(hit.items); // rate-limited — stale results beat an error
      throw new Error("GitHub rate limit reached — try again in a minute.");
    }
    if (!res.ok) {
      if (hit) return withFreshThumbs(hit.items);
      throw new Error(`GitHub search failed (${res.status})`);
    }
    const body = await res.json();
    const items = (body.items || []).map((r) => {
      const fullName = r.full_name;
      // The search payload carries the owner's avatar on the direct avatars CDN —
      // pass it through so the card paints instantly without GitHub's redirecting
      // github.com/owner.png, and so it's the fallback thumbnail when no icon/
      // preview is resolved.
      const avatarUrl = (r.owner && r.owner.avatar_url) || null;
      return {
        fullName,
        description: r.description,
        stars: r.stargazers_count || 0,
        createdAt: r.created_at || null,
        updatedAt: r.updated_at,
        topics: Array.isArray(r.topics) ? r.topics : [],
        avatarUrl,
        thumbnail: cachedThumbnail(fullName, avatarUrl),
        source: "live",
      };
    });
    searchCache.set(key, { at: Date.now(), items });
    persistSearchDisk();
    return items;
  }

  // Browse-grid entry point. For the default topic we serve the prebuilt registry
  // index (one CDN fetch, the whole catalogue, thumbnails already baked); a custom
  // topic — or an index that isn't reachable / published yet — falls back to a live
  // GitHub Search. Keeping both paths means the store never regresses for users on a
  // custom topic and degrades gracefully if the registry repo is down.
  async function searchExtensions(query, topic, force = false) {
    const t = String(topic || DEFAULT_EXT_TOPIC).trim();
    if (t === DEFAULT_EXT_TOPIC) {
      const index = await registry.fetchRegistryIndex(force);
      // Zip asset lists stay in main: registryVersionsFor reads them from the
      // cached index, the renderer only needs the card fields.
      if (usableIndex(index)) {
        const vocabulary = registry.cachedVocabulary();
        return filterRegistry(index, query, vocabulary).map(({ versions, ...item }) => item);
      }
    }
    return searchExtensionsLive(query, topic, force);
  }

  return { searchExtensions };
}

module.exports = { createSearch };
