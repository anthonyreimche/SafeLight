// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Browse-card thumbnails. The best store thumbnail for a browse card, resolved
// in priority order:
//   1. the extension's manifest-declared icon (jsDelivr, ~1 KB, distinct per ext)
//   2. the owner's *custom* social preview (og:image — skipped when GitHub only
//      has its auto-generated card, which is slow to render and not distinctive)
//   3. the owner avatar (instant CDN image; identical across one owner's repos)
// `custom` is false only for the avatar fallback, so the card letterboxes it
// (contain + pad) rather than filling the frame like a purpose-made icon/preview.
// Resolution runs in the main process (batched + parallel, off the render path)
// and rides the icon/og disk caches, so the first open pays once and every
// re-open is served warm.

const fs = require("node:fs");
const path = require("node:path");
const { validRepo } = require("../window-policy.cjs");
const { avatarFor } = require("../registry-entry.cjs");

const OG_TTL_MS = 6 * 60 * 60 * 1000;
const ICON_TTL_MS = 6 * 60 * 60 * 1000;

// GitHub's auto-generated summary card (repo name, description, stats). Always
// available, but it is NOT the owner's uploaded social preview.
function autoOgCard(repo) {
  return `https://opengraph.githubassets.com/1/${repo}`;
}

function isAutoOgCard(url) {
  return (
    typeof url === "string" &&
    url.startsWith("https://opengraph.githubassets.com/")
  );
}

/**
 * @param {{
 *   net: { fetch: typeof fetch },
 *   userData: () => string,
 *   fileWriter: { write(file: string, data: string): Promise<void> },
 * }} deps
 */
function createThumbnails({ net, userData, fileWriter }) {
  // net.fetch with a hard deadline. Without it a single stalled socket (TLS hang,
  // silent drop) blocks for the OS TCP timeout — minutes — and since the browse
  // grid resolves 25 thumbnails together, one hang would freeze the whole grid.
  async function fetchWithTimeout(url, opts, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      return await net.fetch(url, { ...opts, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  // Resolve a repo's real og:image. When the owner uploaded a custom social
  // preview, GitHub points og:image at repository-images.githubusercontent.com;
  // otherwise it's the auto-generated card above. There is no unauthenticated REST
  // field for this, so we read <meta property="og:image"> from the repo's HTML.
  // Cached in-process (TTL) — the URL only changes when the owner edits the
  // preview, and a browse grid asks for ~25 of these at once. The cache is also
  // mirrored to disk: without it, every cold launch re-scrapes ~25 github.com HTML
  // pages the first time Browse opens (most of which return the auto-card anyway),
  // which is the bulk of the store's open-time latency.
  const ogImageCache = new Map(); // repo(lowercase) -> { url, at }
  const ogCacheFile = () => path.join(userData(), "og-cache.json");
  let ogCacheLoaded = false;

  // Seed the in-memory map from disk on first use (lazy: only the Extensions store
  // touches og:images, so don't pay this on every launch). Stale entries are kept —
  // fetchOgImage re-validates against OG_TTL_MS per lookup.
  function loadOgDisk() {
    if (ogCacheLoaded) return;
    ogCacheLoaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(ogCacheFile(), "utf8"));
      if (raw && typeof raw === "object")
        for (const [k, v] of Object.entries(raw))
          if (v && typeof v.url === "string" && typeof v.at === "number")
            ogImageCache.set(k, { url: v.url, at: v.at });
    } catch {}
  }

  let ogWriteTimer = null;
  // Debounced so a 25-card browse-grid burst writes the file once, not 25 times.
  function persistOgDisk() {
    if (ogWriteTimer) return;
    ogWriteTimer = setTimeout(() => {
      ogWriteTimer = null;
      fileWriter
        .write(ogCacheFile(), JSON.stringify(Object.fromEntries(ogImageCache)))
        .catch(() => {});
    }, 1000);
    if (ogWriteTimer.unref) ogWriteTimer.unref();
  }

  async function fetchOgImage(repo, force = false) {
    if (!validRepo(repo)) return autoOgCard(repo);
    loadOgDisk();
    const key = repo.toLowerCase();
    const hit = ogImageCache.get(key);
    // `force` (the store's ↻) bypasses the cache; the github.com scrape is always
    // live, so a just-uploaded social preview shows on reload instead of in ≤6h.
    if (!force && hit && Date.now() - hit.at < OG_TTL_MS) return hit.url;
    let url = autoOgCard(repo);
    try {
      const res = await fetchWithTimeout(
        `https://github.com/${repo}`,
        { headers: { "User-Agent": "Safelight", Accept: "text/html" } },
        6000,
      );
      if (res.ok && res.body) {
        // og:image lives in <head>, so stop reading once we've seen it (or hit a
        // cap) rather than downloading the whole page for every card. 48 KB is well
        // past <head> on a repo page; reading less = each of the 25 scrapes returns
        // sooner, which (with Chromium's 6-connection-per-host limit) is what drives
        // the grid's cold-open time.
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let html = "";
        while (html.length < 48000) {
          const { done, value } = await reader.read();
          if (done) break;
          html += decoder.decode(value, { stream: true });
          if (/property=["']og:image["']/i.test(html)) break;
        }
        try {
          await reader.cancel();
        } catch {}
        const m =
          html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
          html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
        if (m && /^https:\/\//i.test(m[1])) url = m[1];
      }
    } catch {
      // Network/parse failure → keep the auto card. Never throw: a missing
      // thumbnail must not break the browse grid.
    }
    ogImageCache.set(key, { url, at: Date.now() });
    persistOgDisk();
    return url;
  }

  // Manifest-declared store icon, resolved to a CDN URL. Browse cards default to
  // the owner avatar (instant, no round-trip); this upgrades a card to the
  // extension's own icon when its safelight.json declares one. The manifest is read
  // from jsDelivr (CDN-edge cached, ~1 KB) rather than GitHub's rate-limited API,
  // and the resolved URL is mirrored to disk so a warm Browse open needs no network
  // at all. This replaced per-card og:image HTML scraping + GitHub's on-demand
  // opengraph card render, which together were the bulk of the store's open latency.
  const iconUrlCache = new Map(); // repo(lowercase) -> { url|null, at }
  const iconCacheFile = () => path.join(userData(), "icon-cache.json");
  let iconCacheLoaded = false;

  function loadIconDisk() {
    if (iconCacheLoaded) return;
    iconCacheLoaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(iconCacheFile(), "utf8"));
      if (raw && typeof raw === "object")
        for (const [k, v] of Object.entries(raw))
          if (v && typeof v.at === "number" && (v.url === null || typeof v.url === "string"))
            iconUrlCache.set(k, { url: v.url, at: v.at });
    } catch {}
  }

  let iconWriteTimer = null;
  // Debounced so a 25-card browse-grid burst writes the file once, not 25 times.
  function persistIconDisk() {
    if (iconWriteTimer) return;
    iconWriteTimer = setTimeout(() => {
      iconWriteTimer = null;
      fileWriter
        .write(iconCacheFile(), JSON.stringify(Object.fromEntries(iconUrlCache)))
        .catch(() => {});
    }, 1000);
    if (iconWriteTimer.unref) iconWriteTimer.unref();
  }

  async function fetchIconUrl(repo, force = false) {
    if (!validRepo(repo)) return null;
    loadIconDisk();
    const key = repo.toLowerCase();
    const hit = iconUrlCache.get(key);
    // null is a real, cacheable answer ("no declared icon") — don't re-fetch it.
    // `force` (the store's ↻) bypasses the cache so a just-added/changed icon shows.
    if (!force && hit && Date.now() - hit.at < ICON_TTL_MS) return hit.url;
    let url = null;
    try {
      // No @version → jsDelivr serves the repo's default-branch HEAD, off a CDN
      // that isn't subject to GitHub's API rate limit. On a forced refresh, read
      // the manifest from raw.githubusercontent.com instead: jsDelivr edge-caches
      // HEAD for hours, so a freshly-pushed icon wouldn't appear via it yet.
      const manifestUrl = force
        ? `https://raw.githubusercontent.com/${repo}/HEAD/safelight.json`
        : `https://cdn.jsdelivr.net/gh/${repo}/safelight.json`;
      const res = await fetchWithTimeout(
        manifestUrl,
        { headers: { "User-Agent": "Safelight", Accept: "application/json" } },
        5000,
      );
      if (res.ok) {
        const manifest = await res.json();
        const icon =
          manifest && typeof manifest.icon === "string" ? manifest.icon.trim() : "";
        if (/^https:\/\//i.test(icon)) url = icon;
        // Relative path → resolve against the same CDN tree. Reject absolute paths
        // and `..` so a manifest can't point the URL outside its own repo.
        else if (icon && !icon.startsWith("/") && !icon.includes(".."))
          url = `https://cdn.jsdelivr.net/gh/${repo}/${icon.replace(/^\.?\//, "")}`;
      }
    } catch {
      // Missing manifest / network → no custom icon; the card keeps the avatar.
    }
    iconUrlCache.set(key, { url, at: Date.now() });
    persistIconDisk();
    return url;
  }

  // Synchronous best-effort read from the warm icon/og caches — no network. Lets
  // searchExtensions hand the renderer a resolved thumbnail the instant the caches
  // are warm (every open after the first), so re-opens paint real icons with zero
  // round-trips. Falls back to the avatar when nothing is cached yet.
  function cachedThumbnail(repo, avatarUrl) {
    loadIconDisk();
    loadOgDisk();
    const key = String(repo).toLowerCase();
    const now = Date.now();
    const icon = iconUrlCache.get(key);
    if (icon && icon.url && now - icon.at < ICON_TTL_MS)
      return { url: icon.url, custom: true };
    const og = ogImageCache.get(key);
    if (og && og.url && !isAutoOgCard(og.url) && now - og.at < OG_TTL_MS)
      return { url: og.url, custom: true };
    return { url: avatarFor(repo, avatarUrl), custom: false };
  }

  // Full resolution with network as needed (and cache fills). Prefers the cheap
  // manifest icon; only scrapes the og:image when no icon is declared, and only
  // keeps it when it's a real uploaded preview (not GitHub's auto-card).
  async function resolveThumbnail(repo, avatarUrl, force = false) {
    if (!validRepo(repo)) return { url: avatarFor(repo, avatarUrl), custom: false };
    const icon = await fetchIconUrl(repo, force);
    if (icon) return { url: icon, custom: true };
    const og = await fetchOgImage(repo, force);
    if (og && !isAutoOgCard(og)) return { url: og, custom: true };
    return { url: avatarFor(repo, avatarUrl), custom: false };
  }

  // Batch entry point for the browse grid: resolve every card's thumbnail in
  // parallel, returning a { "owner/repo": { url, custom } } map. `onEach` (when
  // given) fires per repo the moment it resolves, so the renderer can upgrade each
  // card progressively instead of waiting for the slowest one. Never rejects — a
  // repo that fails resolution simply falls back to its avatar.
  async function resolveThumbnails(items, onEach, force = false) {
    const list = Array.isArray(items) ? items.slice(0, 100) : [];
    const out = {};
    await Promise.all(
      list.map(async (it) => {
        const repo = it && typeof it.repo === "string" ? it.repo : null;
        if (!repo || !validRepo(repo)) return;
        const avatar = it && typeof it.avatar === "string" ? it.avatar : null;
        let thumb;
        try {
          thumb = await resolveThumbnail(repo, avatar, force);
        } catch {
          thumb = { url: avatarFor(repo, avatar), custom: false };
        }
        out[repo] = thumb;
        if (onEach) {
          try {
            onEach(repo, thumb);
          } catch {}
        }
      })
    );
    return out;
  }

  return { fetchOgImage, cachedThumbnail, resolveThumbnails };
}

module.exports = { createThumbnails };
