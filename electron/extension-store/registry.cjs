// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Prebuilt registry index: a static catalog of every published extension,
// regenerated server-side by a GitHub Action in the registry repo
// (TRUST_REGISTRY) and committed as registry.json. The store fetches this ONE
// CDN-cached file instead of running a live GitHub Search + a per-card icon/og
// resolution on every machine: one request, no API rate limit, the COMPLETE
// catalog (not the search endpoint's first page of 25), and the thumbnails
// already resolved. This is how the store loads the full list fast; the live
// search (search.cjs) stays as the fallback.

const fs = require("node:fs");
const path = require("node:path");
const { usableIndex } = require("../registry-cache.cjs");
const { normalizeRegistryEntry, parseVocabulary, readIndexCache } = require("../registry-entry.cjs");
const { createRemoteJsonCache } = require("../remote-json-cache.cjs");
const { TRUST_REGISTRY } = require("./trust.cjs");

const DEFAULT_EXT_TOPIC = "safelight-extension";
const REGISTRY_INDEX_TTL_MS = 60 * 60 * 1000; // catalog turns over slowly; 1h

/**
 * @param {{
 *   net: { fetch: typeof fetch },
 *   userData: () => string,
 *   fileWriter: { write(file: string, data: string): Promise<void> },
 * }} deps
 */
function createRegistryIndex({ net, userData, fileWriter }) {
  let registryIndexCache = null; // { at, items, vocabulary } | null
  const registryIndexFile = () => path.join(userData(), "registry-index.json");
  let registryIndexLoaded = false;

  function loadRegistryDisk() {
    if (registryIndexLoaded) return;
    registryIndexLoaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(registryIndexFile(), "utf8"));
      registryIndexCache = readIndexCache(raw);
    } catch {}
  }

  let registryWriteTimer = null;
  function persistRegistryDisk() {
    if (registryWriteTimer) return;
    registryWriteTimer = setTimeout(() => {
      registryWriteTimer = null;
      fileWriter
        .write(registryIndexFile(), JSON.stringify(registryIndexCache))
        .catch(() => {});
    }, 1000);
    if (registryWriteTimer.unref) registryWriteTimer.unref();
  }

  // Fetch + cache the registry index. Returns the extension array, or null only
  // when the index is genuinely unavailable (fetch failed / not published yet AND
  // nothing cached) so the caller can fall back to a live search. A fresh cache
  // short-circuits the network; a stale cache is still returned on any fetch
  // failure (last-good beats an error, same policy as searchExtensionsLive).
  async function loadRegistryIndex(force) {
    loadRegistryDisk();
    if (
      !force &&
      registryIndexCache &&
      Date.now() - registryIndexCache.at < REGISTRY_INDEX_TTL_MS
    )
      return registryIndexCache.items;
    // Always read GitHub's own raw CDN (Fastly, max-age=300), never jsDelivr: the
    // un-versioned jsDelivr /gh/ URL serves the file with Cache-Control: max-age=
    // 604800 (7 days), which Electron's net.fetch HTTP cache honours — so once our
    // 1h TTL above lapses the "refetch" is served from Electron's local cache for up
    // to a week and the store never sees a freshly-rebuilt registry. raw.github-
    // usercontent isn't API-rate-limited (it's the file CDN, not api.github.com) —
    // the same source the trust lists already use. `cache: "no-cache"` forces a
    // (cheap, 304-able) revalidation so our 1h TTL is the single source of truth.
    const url = `https://raw.githubusercontent.com/${TRUST_REGISTRY}/main/registry.json`;
    try {
      // The signal, unlike fetchWithTimeout's timer, stays armed while the body is
      // read: a stalled registry.json must not wedge registryIndexInflight.
      const res = await net.fetch(url, {
        headers: { "User-Agent": "Safelight", Accept: "application/json" },
        cache: "no-cache",
        signal: AbortSignal.timeout(6000),
      });
      // 404 = index not published yet; any non-OK = serve last-good or signal
      // "unavailable" (null) so searchExtensions falls back to a live search.
      if (!res.ok) return registryIndexCache ? registryIndexCache.items : null;
      const body = await res.json();
      const rows = Array.isArray(body)
        ? body
        : body && Array.isArray(body.extensions)
          ? body.extensions
          : null;
      if (!rows) return registryIndexCache ? registryIndexCache.items : null;
      const items = rows.map(normalizeRegistryEntry).filter(Boolean);
      // Cached, an empty catalog would blank the store for the whole TTL.
      if (!usableIndex(items)) return registryIndexCache ? registryIndexCache.items : null;
      registryIndexCache = { at: Date.now(), items, vocabulary: parseVocabulary(body) };
      persistRegistryDisk();
      return items;
    } catch {
      return registryIndexCache ? registryIndexCache.items : null;
    }
  }

  // Update checks read the index from up to eight workers at once; while the
  // network fetch is in flight they share it instead of each downloading it.
  let registryIndexInflight = null;
  function fetchRegistryIndex(force = false) {
    if (force) return loadRegistryIndex(true);
    if (!registryIndexInflight)
      registryIndexInflight = loadRegistryIndex(false).finally(() => {
        registryIndexInflight = null;
      });
    return registryIndexInflight;
  }

  // The vocabulary of the index as last loaded, without fetching.
  const cachedVocabulary = () => (registryIndexCache ? registryIndexCache.vocabulary : null);

  // The registry's version record for "owner/repo": undefined when the index is
  // unavailable, doesn't list the repo, or predates version records, so callers
  // ask GitHub themselves.
  async function registryVersionsFor(repo) {
    const items = await fetchRegistryIndex();
    if (!items) return undefined;
    const key = String(repo).toLowerCase();
    const hit = items.find((it) => it.fullName.toLowerCase() === key);
    return (hit && hit.versions) || undefined;
  }

  // The category vocabulary published in registry.json, for the store's rail and
  // category pages; null when the index, or its vocabulary, is unavailable.
  async function storeVocabulary() {
    await fetchRegistryIndex(false);
    return registryIndexCache ? registryIndexCache.vocabulary : null;
  }

  return { fetchRegistryIndex, cachedVocabulary, registryVersionsFor, storeVocabulary };
}

// The welcome setup's starter kits: curated groups of verified extensions,
// published as kits.json beside registry.json so they change without an app
// release. Same CDN and cache discipline as the registry index (raw, never
// jsDelivr, `cache: "no-cache"` so the 1h TTL is the only clock).
/** @param {{ net: { fetch: typeof fetch }, userData: () => string }} deps */
function createKitsIndex({ net, userData }) {
  return createRemoteJsonCache({
    url: `https://raw.githubusercontent.com/${TRUST_REGISTRY}/main/kits.json`,
    cacheFile: () => path.join(userData(), "kits-cache.json"),
    ttlMs: 60 * 60 * 1000,
    // The signal, unlike fetchWithTimeout's, stays armed while the cache reads
    // the body.
    fetchJson: (url) =>
      net.fetch(url, {
        headers: { "User-Agent": "Safelight", Accept: "application/json" },
        cache: "no-cache",
        signal: AbortSignal.timeout(6000),
      }),
  });
}

module.exports = { DEFAULT_EXT_TOPIC, createRegistryIndex, createKitsIndex };
