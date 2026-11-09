// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Extension trust registry: a separate GitHub repo holding two JSON lists —
// verified.json (repos a human reviewed and vouches for) and banned.json (a
// remote kill-switch for repos/owners that turn malicious). Fetched in the
// main process so the renderer CSP (connect-src 'self') never blocks it, and
// cached with a TTL so a browse grid or a launch sweep doesn't re-fetch on every
// call. Tolerant of failure: a network outage keeps the last-good list (never
// un-bans on a hiccup), and a 404 reads as "file not present yet" → empty, so a
// registry with only one file still works.

const fs = require("node:fs");
const path = require("node:path");

const TRUST_REGISTRY = "anthonyreimche/safelight-registry";
const TRUST_TTL_MS = 6 * 60 * 60 * 1000;
const EMPTY_TRUST = { verified: [], reviewed: {}, repos: [], owners: [], reason: {} };

const lcTrim = (s) => String(s || "").trim().toLowerCase();
const lcList = (a) => (Array.isArray(a) ? a.map(lcTrim).filter(Boolean) : []);

// verified.json entries may be a bare "owner/repo" (legacy, unpinned) or an object
// { repo, version, commit } that pins the reviewed point. Returns the flat repo
// allowlist plus a per-repo map of what was reviewed, so a version pushed after
// review can be detected as "stale-verified" (unreviewed code) downstream.
function parseVerified(arr) {
  const verified = [];
  const reviewed = {};
  if (!Array.isArray(arr)) return { verified, reviewed };
  for (const e of arr) {
    if (typeof e === "string") {
      const r = lcTrim(e);
      if (r) verified.push(r);
    } else if (e && typeof e === "object" && e.repo) {
      const r = lcTrim(e.repo);
      if (!r) continue;
      verified.push(r);
      const rv = {};
      if (e.version) rv.version = String(e.version).trim();
      if (e.commit) rv.commit = lcTrim(e.commit);
      if (rv.version || rv.commit) reviewed[r] = rv;
    }
  }
  return { verified, reviewed };
}
const asReviewed = (o) => (o && typeof o === "object" ? o : {});

// The ban reason when a repo ("owner/repo") or its whole owner is blocked, else
// null. A specific repo reason wins over an owner-wide one.
function bannedReason(list, owner, repo) {
  const full = lcTrim(`${owner}/${repo}`);
  const own = lcTrim(owner);
  if (list.repos.includes(full) || list.owners.includes(own))
    return list.reason[full] || list.reason[own] || "flagged as unsafe";
  return null;
}

/**
 * @param {{
 *   net: { fetch: typeof fetch },
 *   userData: () => string,
 *   fileWriter: { write(file: string, data: string): Promise<void> },
 * }} deps
 */
function createTrustList({ net, userData, fileWriter }) {
  let trustCache = null; // { at, list }

  async function fetchTrustJson(file) {
    // Bounded so offline / captive-portal launches fail fast: loadExternalPlugins
    // awaits this before activating installed extensions, and a hung socket would
    // otherwise delay them for the OS connection timeout (tens of seconds). On
    // timeout this throws → fetchTrustList keeps the last-good list, extensions
    // load unblocked.
    const res = await net.fetch(
      `https://raw.githubusercontent.com/${TRUST_REGISTRY}/main/${file}`,
      {
        headers: { "User-Agent": "Safelight", Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      }
    );
    if (res.status === 404) return {}; // file not in the registry (yet) → empty
    if (!res.ok) throw new Error(`trust list ${file}: ${res.status}`);
    return res.json();
  }

  const trustCacheFile = () => path.join(userData(), "trust-cache.json");

  // Last-good list from disk, or null. Persisting it means every launch after the
  // first reads the lists locally — no network on the boot path — and bans still
  // apply offline / on a cold start (they survive restarts).
  function readTrustDisk() {
    try {
      const raw = JSON.parse(fs.readFileSync(trustCacheFile(), "utf8"));
      if (raw && typeof raw.at === "number" && raw.list)
        return {
          at: raw.at,
          list: {
            verified: lcList(raw.list.verified),
            reviewed: asReviewed(raw.list.reviewed),
            repos: lcList(raw.list.repos),
            owners: lcList(raw.list.owners),
            reason:
              raw.list.reason && typeof raw.list.reason === "object" ? raw.list.reason : {},
          },
        };
    } catch {}
    return null;
  }

  function writeTrustDisk(cache) {
    fileWriter.write(trustCacheFile(), JSON.stringify(cache)).catch(() => {});
  }

  // Fetch both list files and normalize. Throws if either errors (network/5xx) so
  // the caller can keep the last-good copy.
  async function fetchTrustNetwork() {
    const [verified, banned] = await Promise.all([
      fetchTrustJson("verified.json"),
      fetchTrustJson("banned.json"),
    ]);
    const reason = {};
    if (banned && banned.reason && typeof banned.reason === "object")
      for (const [k, v] of Object.entries(banned.reason)) reason[lcTrim(k)] = String(v);
    const { verified: vList, reviewed } = parseVerified(verified && verified.verified);
    return {
      verified: vList,
      reviewed,
      repos: lcList(banned && banned.repos),
      owners: lcList(banned && banned.owners),
      reason,
    };
  }

  // In-memory cache seeded from disk (last-good survives restarts and offline), with
  // a network refresh only when stale. The renderer never awaits this on its boot
  // path — it decides from its own localStorage mirror and refreshes in the
  // background — so the bounded network wait here is always off the critical path.
  async function fetchTrustList(force = false) {
    if (!trustCache) trustCache = readTrustDisk();
    if (!force && trustCache && Date.now() - trustCache.at < TRUST_TTL_MS)
      return trustCache.list;
    try {
      trustCache = { at: Date.now(), list: await fetchTrustNetwork() };
      writeTrustDisk(trustCache);
      return trustCache.list;
    } catch {
      // Never fetched: there is no blocklist to check, and the installer must know.
      return trustCache ? trustCache.list : { ...EMPTY_TRUST, unchecked: true };
    }
  }

  return { fetchTrustList };
}

module.exports = { TRUST_REGISTRY, bannedReason, createTrustList };
