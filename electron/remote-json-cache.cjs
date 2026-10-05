// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// One remote JSON file served to the renderer from a cache: memory first, then
// a last-good copy on disk, refreshed from the network once it is older than
// the TTL (or on `force`). Any failure (offline, a timeout, a non-OK status, a
// body that isn't JSON) serves the last-good copy, and null only when nothing
// was ever fetched. main.cjs supplies the real fetch and paths; tests inject
// their own.

const fs = require("node:fs");

/**
 * @param {{
 *   url: string,
 *   cacheFile: () => string,
 *   ttlMs: number,
 *   fetchJson: (url: string) => Promise<{ ok: boolean, json(): Promise<unknown> }>,
 *   now?: () => number,
 * }} opts
 */
function createRemoteJsonCache({ url, cacheFile, ttlMs, fetchJson, now = Date.now }) {
  let cache = null; // { at, data } | null
  let diskRead = false;
  let refreshing = null;

  function readDisk() {
    if (diskRead) return;
    diskRead = true;
    try {
      const raw = JSON.parse(fs.readFileSync(cacheFile(), "utf8"));
      if (raw && typeof raw.at === "number" && "data" in raw)
        cache = { at: raw.at, data: raw.data };
    } catch {}
  }

  async function refresh() {
    try {
      const res = await fetchJson(url);
      if (!res.ok) return cache ? cache.data : null;
      const data = await res.json();
      cache = { at: now(), data };
      await fs.promises
        .writeFile(cacheFile(), JSON.stringify(cache))
        .catch(() => {});
      return data;
    } catch {
      return cache ? cache.data : null;
    }
  }

  function get(force = false) {
    readDisk();
    if (!force && cache && now() - cache.at < ttlMs)
      return Promise.resolve(cache.data);
    if (!refreshing)
      refreshing = refresh().finally(() => {
        refreshing = null;
      });
    return refreshing;
  }

  return { get };
}

module.exports = { createRemoteJsonCache };
