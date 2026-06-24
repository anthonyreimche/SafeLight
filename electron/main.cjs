// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.
//
// SafeLight — Electron main process
//
// libraw-wasm decodes RAW files on shared memory in a Web Worker, which only
// works when the page is *cross-origin isolated* (COOP/COEP) and served from a
// secure origin. file:// can do neither, so we register a privileged custom
// scheme `app://` and serve the built `dist/` through it, attaching the
// isolation headers to every response. This is the load-bearing part — without
// it RAW decoding silently falls back / fails.

const {
  app,
  protocol,
  BrowserWindow,
  Menu,
  shell,
  net,
  ipcMain,
  session,
  dialog,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const zlib = require("node:zlib");
const { pathToFileURL } = require("node:url");

// `app.isPackaged` is false when Electron runs an app from a plain directory
// rather than an asar/bundled build — which is exactly how the Nix derivation
// launches us (nixpkgs' own `electron` + our dist/ + electron/). The wrapper
// sets SAFELIGHT_PACKAGED=1 so we still take the packaged code path (no
// auto-DevTools) there. No effect on the electron-builder Win/Mac/Linux builds.
const isDev = !app.isPackaged && process.env.SAFELIGHT_PACKAGED !== "1";
const DIST = path.join(__dirname, "..", "dist");

function appVersion() {
  return app.getVersion();
}

// ---------------------------------------------------------------------------
// GPU / renderer performance. Must run before app `ready`.
// Without these, packaged Electron on Windows can land on the integrated GPU,
// an old ANGLE backend, or SwiftShader software WebGL — all much slower than
// the same page in Chrome. Match Chrome's fast path explicitly.
// ---------------------------------------------------------------------------
if (process.platform === "linux") {
  // ---------------------------------------------------------------------------
  // ANGLE backend auto-detection with persistence.
  //
  // appendSwitch must run before app.ready, so GPU failures can't be caught
  // inline. Strategy:
  //   1. On first launch, read a cached backend from XDG config. If none,
  //      start with "gl" (desktop OpenGL via ANGLE — broadest Mesa support).
  //   2. If the GPU process fails before any window appears, delete the cache
  //      and relaunch immediately with the next backend in the list ("gles",
  //      then "vulkan"). The relaunch is invisible to the user.
  //   3. On the first launch that survives to app.ready, write the working
  //      backend to cache — subsequent cold starts skip the probe entirely.
  //   4. A runtime GPU crash (window already visible) is left alone; the app
  //      handles it without relaunching.
  // ---------------------------------------------------------------------------
  // Vulkan + ozone-platform=wayland is incompatible (Chromium warns and may
  // crash). When running under a native Wayland compositor, limit the probe
  // list to OpenGL backends so the warning never appears and a stale cached
  // "vulkan" value from a prior X11 session is silently ignored (indexOf
  // returns -1, so angleIdx falls back to 0 = "gl").
  const isWayland = !!process.env.WAYLAND_DISPLAY;
  const ANGLE_BACKENDS = isWayland ? ["gl", "gles"] : ["gl", "gles", "vulkan"];
  const configDir = path.join(
    process.env.XDG_CONFIG_HOME ||
      path.join(process.env.HOME || "", ".config"),
    "safelight"
  );
  const backendCache = path.join(configDir, "gpu-backend");

  // Prefer the cached backend; fall back to the relaunch-index argv, then "gl".
  let angleIdx = 0;
  const idxArg = process.argv.find((a) => a.startsWith("--safelight-angle-idx="));
  if (idxArg) {
    angleIdx = parseInt(idxArg.split("=")[1], 10) || 0;
  } else {
    try {
      const cached = fs.readFileSync(backendCache, "utf8").trim();
      const ci = ANGLE_BACKENDS.indexOf(cached);
      if (ci !== -1) angleIdx = ci;
    } catch { /* no cache yet */ }
  }
  angleIdx = Math.max(0, Math.min(angleIdx, ANGLE_BACKENDS.length - 1));
  const backend = ANGLE_BACKENDS[angleIdx];

  app.commandLine.appendSwitch("use-angle", backend);
  app.commandLine.appendSwitch("disable-gpu-sandbox");
  app.commandLine.appendSwitch("enable-webgl");
  // Native Wayland rendering (no XWayland overhead); auto-detects X11 too.
  app.commandLine.appendSwitch("ozone-platform-hint", "auto");

  // Persist the working backend once the app reaches ready (GPU confirmed OK).
  app.whenReady().then(() => {
    try {
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(backendCache, backend, "utf8");
    } catch { /* non-fatal */ }
  });

  // On GPU process failure: clear the stale cache and relaunch with the next
  // backend — but only if no window is visible yet (startup failure, not a
  // runtime crash mid-session).
  app.on("child-process-gone", (_event, details) => {
    const failReasons = new Set(["crashed", "launch-failed", "abnormal-exit"]);
    if (
      details.type === "GPU" &&
      failReasons.has(details.reason) &&
      BrowserWindow.getAllWindows().length === 0 &&
      angleIdx + 1 < ANGLE_BACKENDS.length
    ) {
      try { fs.unlinkSync(backendCache); } catch { /* already gone */ }
      const args = process.argv
        .slice(1)
        .filter((a) => !a.startsWith("--safelight-angle-idx="));
      app.relaunch({ args: [...args, `--safelight-angle-idx=${angleIdx + 1}`] });
      app.exit(0);
    }
  });
} else if (process.platform === "win32") {
  app.commandLine.appendSwitch("use-angle", "d3d11"); // modern ANGLE backend (no D3D9/WARP fallback)
}
app.commandLine.appendSwitch("force_high_performance_gpu"); // discrete GPU on dual-GPU machines
app.commandLine.appendSwitch("ignore-gpu-blocklist"); // don't silently drop to SwiftShader
app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("enable-zero-copy");
// SharedArrayBuffer: Chromium only grants crossOriginIsolated on http(s)
// origins, so the COOP/COEP headers on app:// are not honored and libraw-wasm
// would fall back to the slow CPU decoder / embedded JPEG preview. This flag
// re-enables SAB unconditionally (safe here — we only load our own bundle).
app.commandLine.appendSwitch(
  "enable-features",
  "CanvasOopRasterization,SharedArrayBuffer"
);
// Keep RAW-decode workers and renders at full speed when the window is occluded
// or in the background (Lightroom-style apps keep processing).
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
};

const ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  // `credentialless` (not `require-corp`) keeps the app cross-origin-isolated —
  // crossOriginIsolated stays true, so SharedArrayBuffer / libraw-wasm threads
  // still work — while letting no-cors cross-origin images load without a CORP
  // header. That's what the Extensions store needs: GitHub OG thumbnails, owner
  // avatars, and remote README screenshots/badges are served without
  // Cross-Origin-Resource-Policy, so under require-corp they were blocked and
  // rendered as blank/grey cards.
  "Cross-Origin-Embedder-Policy": "credentialless",
  "Cross-Origin-Resource-Policy": "same-origin",
};

// CSP for the app shell. Everything is same-origin (app://bundle), including
// installed extensions (/__plugins__/...). 'wasm-unsafe-eval' is required for
// libraw-wasm; blob: workers/scripts cover Vite's worker bootstrap; inline
// styles cover React style props + Tailwind.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' blob:",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  // https: lets the Extensions store show remote previews: repo thumbnails,
  // owner avatars, and images inside rendered extension READMEs (badges,
  // screenshots). Images can't execute code, and script-src/connect-src stay
  // locked to 'self', so this widens display only — no new code or data egress.
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-src 'none'",
].join("; ");

// Must run before app `ready`. `standard` + `secure` gives the scheme a real
// origin and a secure context (required for SharedArrayBuffer); the rest let it
// behave like a normal web server for fetch/streaming/code-cache.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
      codeCache: true,
    },
  },
]);

function resolveRequestPath(urlPath) {
  // Strip query/hash, decode, and join under DIST without escaping it.
  const clean = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
  const rel = path.normalize(clean).replace(/^(\.\.[/\\])+/, "");
  let filePath = path.join(DIST, rel);
  if (!filePath.startsWith(DIST)) filePath = path.join(DIST, "index.html");
  return filePath;
}

function registerProtocol() {
  protocol.handle("app", async (request) => {
    const url = new URL(request.url);

    // Installed extensions are served from userData/plugins under the same
    // origin (/__plugins__/<id>/...), so dynamic import works under COOP/COEP
    // without any CORS dance.
    if (url.pathname.startsWith("/__plugins__/")) {
      const rel = path
        .normalize(decodeURIComponent(url.pathname.slice("/__plugins__/".length)))
        .replace(/^([/\\]|\.\.[/\\])+/, "");
      const filePath = path.join(pluginsDir(), rel);
      if (!filePath.startsWith(pluginsDir()) || !fs.existsSync(filePath)) {
        return new Response("Not found", { status: 404 });
      }
      const res = await net.fetch(pathToFileURL(filePath).toString());
      const headers = new Headers(res.headers);
      const type = MIME[path.extname(filePath).toLowerCase()];
      if (type) headers.set("Content-Type", type);
      for (const [k, v] of Object.entries(ISOLATION_HEADERS)) headers.set(k, v);
      return new Response(res.body, { status: 200, headers });
    }

    let filePath = resolveRequestPath(url.pathname || "/");

    // Directory or missing file: serve index.html so SPA routes resolve.
    try {
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) filePath = path.join(filePath, "index.html");
    } catch {
      const hasExt = path.extname(filePath) !== "";
      if (!hasExt) filePath = path.join(DIST, "index.html");
    }
    if (!fs.existsSync(filePath)) filePath = path.join(DIST, "index.html");

    const res = await net.fetch(pathToFileURL(filePath).toString());
    const headers = new Headers(res.headers);
    const type = MIME[path.extname(filePath).toLowerCase()];
    if (type) headers.set("Content-Type", type);
    if (type === "text/html") headers.set("Content-Security-Policy", CSP);
    for (const [k, v] of Object.entries(ISOLATION_HEADERS)) headers.set(k, v);
    return new Response(res.body, { status: 200, headers });
  });
}

// ---------------------------------------------------------------------------
// Extensions: GitHub repos with a safelight.json manifest, installed into
// userData/plugins/<id>/ and loaded by the renderer as ESM. Repos are fetched
// as tarballs (codeload) and unpacked with a minimal in-process untar so we
// carry zero extra runtime dependencies.
// ---------------------------------------------------------------------------

const pluginsDir = () => path.join(app.getPath("userData"), "plugins");

function validManifest(m) {
  return (
    m &&
    typeof m.id === "string" &&
    /^[a-z0-9][a-z0-9._-]*$/i.test(m.id) &&
    typeof m.name === "string" &&
    typeof m.version === "string" &&
    typeof m.main === "string" &&
    !m.main.includes("..")
  );
}

// True when this app build is older than the extension's declared minimum
// supported version. Dotted versions only; a missing part reads as 0. Mirrors
// the renderer's semver helper so a too-old install is refused before any files
// are written (the renderer can't know minAppVersion until the manifest lands).
function appOlderThan(minVersion) {
  const parse = (v) =>
    String(v)
      .replace(/^v/i, "")
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const cur = parse(appVersion());
  const want = parse(minVersion);
  for (let i = 0; i < 3; i++) {
    const a = cur[i] || 0;
    const b = want[i] || 0;
    if (a !== b) return a < b;
  }
  return false;
}

function listPlugins() {
  const dir = pluginsDir();
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const m = JSON.parse(
        fs.readFileSync(path.join(dir, entry.name, "safelight.json"), "utf8")
      );
      if (validManifest(m) && m.id === entry.name) out.push(m);
    } catch {}
  }
  return out;
}

// Minimal POSIX/GNU tar reader: 512-byte headers, octal sizes, 'L' longnames.
function untar(buf) {
  const files = [];
  let off = 0;
  let longName = null;
  while (off + 512 <= buf.length) {
    const block = buf.subarray(off, off + 512);
    off += 512;
    if (block.every((b) => b === 0)) continue;
    const name =
      longName ?? block.toString("utf8", 0, 100).replace(/\0[\s\S]*$/, "");
    longName = null;
    const size = parseInt(block.toString("utf8", 124, 136).trim(), 8) || 0;
    const type = String.fromCharCode(block[156]);
    const data = buf.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = data.toString("utf8").replace(/\0[\s\S]*$/, "");
    } else if (type === "0" || type === "\0" || block[156] === 0) {
      files.push({ name, data });
    } // dirs ('5'), pax headers ('x'/'g'), links: skipped
  }
  return files;
}

// spec: "owner/repo", "owner/repo#ref", or a github.com URL.
function parseRepoSpec(spec) {
  let s = String(spec).trim();
  const url = s.match(
    /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s#]+?)(?:\.git)?(?:\/tree\/([^\s]+))?\/?$/
  );
  if (url) return { owner: url[1], repo: url[2], ref: url[3] || "HEAD" };
  const [repoPart, ref] = s.split("#");
  const m = repoPart.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!m) throw new Error("Use owner/repo, owner/repo#branch, or a GitHub URL");
  return { owner: m[1], repo: m[2], ref: ref || "HEAD" };
}

// ---------------------------------------------------------------------------
// Extension trust registry: a separate GitHub repo holding two JSON lists —
// verified.json (repos a human reviewed and vouches for) and banned.json (a
// remote kill-switch for repos/owners that turn malicious). Fetched here in the
// main process so the renderer CSP (connect-src 'self') never blocks it, and
// cached with a TTL so a browse grid or a launch sweep doesn't re-fetch on every
// call. Tolerant of failure: a network outage keeps the last-good list (never
// un-bans on a hiccup), and a 404 reads as "file not present yet" → empty, so a
// registry with only one file still works.
// ---------------------------------------------------------------------------
const TRUST_REGISTRY = "anthonyreimche/safelight-registry";
const TRUST_TTL_MS = 6 * 60 * 60 * 1000;
const EMPTY_TRUST = { verified: [], repos: [], owners: [], reason: {} };
let trustCache = null; // { at, list }

const lcTrim = (s) => String(s || "").trim().toLowerCase();
const lcList = (a) => (Array.isArray(a) ? a.map(lcTrim).filter(Boolean) : []);

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

const trustCacheFile = () => path.join(app.getPath("userData"), "trust-cache.json");

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
  fs.promises.writeFile(trustCacheFile(), JSON.stringify(cache)).catch(() => {});
}

// Fetch both list files and normalise. Throws if either errors (network/5xx) so
// the caller can keep the last-good copy.
async function fetchTrustNetwork() {
  const [verified, banned] = await Promise.all([
    fetchTrustJson("verified.json"),
    fetchTrustJson("banned.json"),
  ]);
  const reason = {};
  if (banned && banned.reason && typeof banned.reason === "object")
    for (const [k, v] of Object.entries(banned.reason)) reason[lcTrim(k)] = String(v);
  return {
    verified: lcList(verified && verified.verified),
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
    return trustCache ? trustCache.list : EMPTY_TRUST; // last-good (disk) or empty
  }
}

// The ban reason when a repo ("owner/repo") or its whole owner is blocked, else
// null. A specific repo reason wins over an owner-wide one.
function bannedReason(list, owner, repo) {
  const full = lcTrim(`${owner}/${repo}`);
  const own = lcTrim(owner);
  if (list.repos.includes(full) || list.owners.includes(own))
    return list.reason[full] || list.reason[own] || "flagged as unsafe";
  return null;
}

async function installPlugin(spec) {
  const { owner, repo, ref } = parseRepoSpec(spec);
  // Remote kill-switch: refuse banned repos/owners before any download or write.
  // The renderer enforces this too (nicer UX), but this is the authoritative
  // gate — it holds even if the renderer bundle is tampered with.
  const banned = bannedReason(await fetchTrustList(), owner, repo);
  if (banned)
    throw new Error(`"${owner}/${repo}" is blocked by Safelight — ${banned}.`);
  const tarUrl = `https://codeload.github.com/${owner}/${repo}/tar.gz/${encodeURIComponent(ref)}`;
  const res = await net.fetch(tarUrl);
  if (!res.ok) throw new Error(`GitHub download failed (${res.status})`);
  const tar = zlib.gunzipSync(Buffer.from(await res.arrayBuffer()));

  // Strip the "<repo>-<ref>/" top-level folder GitHub adds.
  const files = untar(tar)
    .map((f) => ({ ...f, name: f.name.split("/").slice(1).join("/") }))
    .filter((f) => f.name && !f.name.split("/").includes(".."));

  const manifestFile = files.find((f) => f.name === "safelight.json");
  if (!manifestFile) throw new Error("Repo has no safelight.json manifest");
  const manifest = JSON.parse(manifestFile.data.toString("utf8"));
  if (!validManifest(manifest)) throw new Error("Invalid safelight.json");
  if (manifest.minAppVersion && appOlderThan(manifest.minAppVersion))
    throw new Error(
      `"${manifest.name}" requires SafeLight ${manifest.minAppVersion} or newer — you have ${appVersion()}. Update SafeLight first.`
    );
  if (!files.some((f) => f.name === manifest.main))
    throw new Error(`Entry bundle "${manifest.main}" not found in repo`);

  const target = path.join(pluginsDir(), manifest.id);
  if (!target.startsWith(pluginsDir())) throw new Error("Bad extension id");
  fs.rmSync(target, { recursive: true, force: true });
  for (const f of files) {
    const dest = path.join(target, f.name);
    if (!dest.startsWith(target)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, f.data);
  }
  return manifest;
}

// Discover official extensions on GitHub by topic (default
// "safelight-extension"; configurable in Preferences ▸ Extensions). Runs in the
// main process so the renderer's COOP/COEP isolation never gets in the way.
//
// Results are cached (memory + disk) per (topic, query) with a short TTL. The
// default browse grid (empty query) is the first thing the store fetches on every
// open, so serving it from a warm cache makes re-opens instant and spares the
// unauthenticated 60/hr GitHub Search budget. On rate-limit / network failure we
// fall back to any cached payload (even if stale) rather than surfacing an error.
const searchCache = new Map(); // `${topic}\n${query}` -> { at, items }
const SEARCH_TTL_MS = 15 * 60 * 1000; // results turn over slowly; 15 min is plenty
const searchCacheFile = () => path.join(app.getPath("userData"), "search-cache.json");
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
}

let searchWriteTimer = null;
function persistSearchDisk() {
  if (searchWriteTimer) return;
  searchWriteTimer = setTimeout(() => {
    searchWriteTimer = null;
    fs.promises
      .writeFile(searchCacheFile(), JSON.stringify(Object.fromEntries(searchCache)))
      .catch(() => {});
  }, 1000);
  if (searchWriteTimer.unref) searchWriteTimer.unref();
}

async function searchExtensions(query, topic, force = false) {
  const t = String(topic || "safelight-extension").trim();
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(t)) throw new Error("Bad extension topic");
  const q = [String(query || "").trim(), `topic:${t}`]
    .filter(Boolean)
    .join(" ");
  loadSearchDisk();
  const key = `${t}\n${String(query || "").trim()}`;
  const hit = searchCache.get(key);
  // Re-resolve each item's thumbnail from the (now-warm) icon/og caches on the
  // way out: a cached search payload may pre-date a thumbnail that has since been
  // resolved, so a warm re-open paints real icons with no round-trips.
  if (!force && hit && Date.now() - hit.at < SEARCH_TTL_MS)
    return hit.items.map((it) => ({
      ...it,
      thumbnail: cachedThumbnail(it.fullName, it.avatarUrl || null),
    }));
  let res;
  try {
    res = await net.fetch(
      `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=25`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "Safelight",
        },
      }
    );
  } catch (e) {
    if (hit) return hit.items; // network hiccup — serve last-good rather than fail
    throw e;
  }
  if (res.status === 403 || res.status === 429) {
    if (hit) return hit.items; // rate-limited — stale results beat an error
    throw new Error("GitHub rate limit reached — try again in a minute.");
  }
  if (!res.ok) {
    if (hit) return hit.items;
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
      updatedAt: r.updated_at,
      topics: Array.isArray(r.topics) ? r.topics : [],
      avatarUrl,
      thumbnail: cachedThumbnail(fullName, avatarUrl),
    };
  });
  searchCache.set(key, { at: Date.now(), items });
  persistSearchDisk();
  return items;
}

async function fetchReleases(repo) {
  // Called from the main process so net.fetch is not subject to the renderer
  // CSP (connect-src 'self') that would block https:// requests.
  const res = await net.fetch(
    `https://api.github.com/repos/${repo}/releases?per_page=20`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Safelight",
      },
    }
  );
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  return res.json();
}

// The `version` from the repo's root safelight.json on its default branch — the
// same field the installed manifest exposes, so the extension updater can detect
// a pushed version bump without requiring a GitHub Release. Null on any failure
// (missing manifest, private repo, network) so the caller simply skips the check.
async function fetchManifestVersion(repo) {
  if (!validRepo(repo)) return null;
  try {
    const res = await net.fetch(
      `https://api.github.com/repos/${repo}/contents/safelight.json`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "Safelight",
        },
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || typeof data.content !== "string") return null;
    const json = Buffer.from(data.content, data.encoding || "base64").toString("utf8");
    const manifest = JSON.parse(json);
    return typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}

// Validate an "owner/repo" string before interpolating it into a GitHub URL.
function validRepo(repo) {
  return /^[\w.-]+\/[\w.-]+$/.test(String(repo));
}

// Repo metadata for the Extensions detail view — runs in the main process to
// bypass the renderer CSP. Returns a normalised subset so we never leak the raw
// GitHub payload (or its many embedded URLs) into the renderer.
// GitHub's auto-generated summary card (repo name, description, stats). Always
// available, but it is NOT the owner's uploaded social preview.
function autoOgCard(repo) {
  return `https://opengraph.githubassets.com/1/${repo}`;
}

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
const OG_TTL_MS = 6 * 60 * 60 * 1000;
const ogCacheFile = () => path.join(app.getPath("userData"), "og-cache.json");
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
    fs.promises
      .writeFile(ogCacheFile(), JSON.stringify(Object.fromEntries(ogImageCache)))
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
const ICON_TTL_MS = 6 * 60 * 60 * 1000;
const iconCacheFile = () => path.join(app.getPath("userData"), "icon-cache.json");
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
    fs.promises
      .writeFile(iconCacheFile(), JSON.stringify(Object.fromEntries(iconUrlCache)))
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

// ── Browse-card thumbnails ───────────────────────────────────────────────────
// The best store thumbnail for a browse card, resolved in priority order:
//   1. the extension's manifest-declared icon (jsDelivr, ~1 KB, distinct per ext)
//   2. the owner's *custom* social preview (og:image — skipped when GitHub only
//      has its auto-generated card, which is slow to render and not distinctive)
//   3. the owner avatar (instant CDN image; identical across one owner's repos)
// `custom` is false only for the avatar fallback, so the card letterboxes it
// (contain + pad) rather than filling the frame like a purpose-made icon/preview.
// Resolution runs in the main process (batched + parallel, off the render path)
// and rides the existing icon/og disk caches, so the first open pays once and
// every re-open is served warm.
function isAutoOgCard(url) {
  return (
    typeof url === "string" &&
    url.startsWith("https://opengraph.githubassets.com/")
  );
}

function avatarFor(repo, avatarUrl) {
  if (avatarUrl) return avatarUrl;
  const owner = String(repo).split("/")[0];
  return `https://github.com/${owner}.png?size=120`;
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
  const list = Array.isArray(items) ? items.slice(0, 50) : [];
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

async function fetchRepoMeta(repo) {
  if (!validRepo(repo)) throw new Error("Bad repository");
  const res = await net.fetch(`https://api.github.com/repos/${repo}`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "Safelight" },
  });
  if (res.status === 403 || res.status === 429)
    throw new Error("GitHub rate limit reached — try again in a minute.");
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const r = await res.json();
  return {
    fullName: r.full_name,
    description: r.description ?? null,
    stars: r.stargazers_count || 0,
    openIssues: r.open_issues_count || 0,
    updatedAt: r.pushed_at || r.updated_at || "",
    license: r.license && r.license.spdx_id !== "NOASSERTION" ? r.license.spdx_id : null,
    topics: Array.isArray(r.topics) ? r.topics : [],
    homepage: r.homepage || null,
    htmlUrl: r.html_url,
    defaultBranch: r.default_branch || "HEAD",
    ownerLogin: r.owner ? r.owner.login : "",
    ownerAvatarUrl: r.owner ? r.owner.avatar_url : null,
    hasIssues: !!r.has_issues,
    hasDiscussions: !!r.has_discussions,
    ogImageUrl: await fetchOgImage(r.full_name),
  };
}

// Raw README text for the Extensions detail view. Returns null when the repo
// has no README (404) so the UI can fall back to the manifest description.
async function fetchReadme(repo, ref) {
  if (!validRepo(repo)) throw new Error("Bad repository");
  const branch = encodeURIComponent(String(ref || "HEAD"));
  for (const name of ["README.md", "readme.md", "README.markdown", "README"]) {
    const res = await net.fetch(
      `https://raw.githubusercontent.com/${repo}/${branch}/${name}`,
      { headers: { "User-Agent": "Safelight" } }
    );
    if (res.ok) return res.text();
    if (res.status !== 404) throw new Error(`GitHub error: ${res.status}`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// In-app updater. Downloads the platform-appropriate release asset and runs
// it, then quits so the installer/AppImage can replace the running copy.
// ---------------------------------------------------------------------------

/** Pick the best asset URL for the current platform from a release assets array. */
function pickAsset(assets) {
  const names = assets.map((a) => ({ name: a.name.toLowerCase(), url: a.browser_download_url, orig: a.name }));
  if (process.platform === "win32") {
    const hit = names.find((a) => a.name.endsWith(".exe"));
    return hit ? { url: hit.url, name: hit.orig, mode: "run-silent" } : null;
  }
  if (process.platform === "linux") {
    // Prefer AppImage — self-contained and can be relaunched directly.
    const appimage = names.find((a) => a.name.endsWith(".appimage"));
    if (appimage) return { url: appimage.url, name: appimage.orig, mode: "appimage" };
    // Fall back to the first package manager format available; open with system handler.
    const pkg = names.find((a) =>
      a.name.endsWith(".deb") || a.name.endsWith(".rpm") ||
      a.name.endsWith(".pacman") || a.name.endsWith(".flatpak")
    );
    if (pkg) return { url: pkg.url, name: pkg.orig, mode: "open" };
  }
  // macOS / unknown: nothing to auto-install.
  return null;
}

async function installRelease(repo, tag) {
  const { spawn } = require("node:child_process");

  // 1. Fetch the release assets list for the given tag.
  const res = await net.fetch(
    `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`,
    { headers: { Accept: "application/vnd.github+json", "User-Agent": "Safelight" } }
  );
  if (!res.ok) throw new Error(`Could not fetch release metadata (${res.status})`);
  const release = await res.json();
  const asset = pickAsset(release.assets || []);
  if (!asset) throw new Error("No installable asset found for your platform.");

  // 2. Download to a temp file.
  const tmpDir = app.getPath("temp");
  const tmpFile = path.join(tmpDir, asset.name);
  const dlRes = await net.fetch(asset.url, { headers: { "User-Agent": "Safelight" } });
  if (!dlRes.ok) throw new Error(`Download failed (${dlRes.status})`);
  const buf = Buffer.from(await dlRes.arrayBuffer());
  fs.writeFileSync(tmpFile, buf);

  // 3. Run / open.
  if (asset.mode === "run-silent") {
    // Open the installer via the OS shell (double-click equivalent) so it
    // runs with the correct elevation prompt and UAC context. A small delay
    // lets the shell finish registering the open before we exit.
    await shell.openPath(tmpFile);
    setTimeout(() => app.quit(), 500);
  } else if (asset.mode === "appimage") {
    // Make executable, relaunch from the new AppImage path, quit old instance.
    fs.chmodSync(tmpFile, 0o755);
    spawn(tmpFile, [], { detached: true, stdio: "ignore" }).unref();
    setTimeout(() => app.quit(), 500);
  } else {
    // Package manager file (.deb, .rpm, etc.) — open with system handler so
    // the user's package manager picks it up; we stay running.
    await shell.openPath(tmpFile);
  }
}

function registerPluginIpc() {
  ipcMain.handle("app:version", () => appVersion());
  // Recolor the native min/max/close overlay to follow the in-app theme
  // (Windows/Linux only — macOS has no overlay, just traffic lights).
  ipcMain.handle("window:setTitleBarOverlay", (e, color, symbolColor) => {
    if (process.platform === "darwin") return;
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    try {
      win.setTitleBarOverlay({
        color: String(color),
        symbolColor: String(symbolColor),
        height: 36,
      });
    } catch {}
  });
  ipcMain.handle("releases:fetch", (_e, repo) => fetchReleases(String(repo)));
  ipcMain.handle("github:repoMeta", (_e, repo) => fetchRepoMeta(String(repo)));
  ipcMain.handle("github:iconUrl", (_e, repo) => fetchIconUrl(String(repo)));
  ipcMain.handle("github:thumbnails", (e, items, force) =>
    resolveThumbnails(
      items,
      (repo, thumb) => {
        if (!e.sender.isDestroyed())
          e.sender.send("github:thumbnail", { repo, thumb });
      },
      !!force,
    )
  );
  ipcMain.handle("github:readme", (_e, repo, ref) =>
    fetchReadme(String(repo), String(ref ?? "HEAD"))
  );
  ipcMain.handle("updates:install", (_e, repo, tag) =>
    installRelease(String(repo), String(tag))
  );
  ipcMain.handle("plugins:list", () => listPlugins());
  ipcMain.handle("plugins:install", (_e, spec) => installPlugin(spec));
  ipcMain.handle("plugins:search", (_e, query, topic, force) =>
    searchExtensions(query, topic, force)
  );
  ipcMain.handle("plugins:latest-version", (_e, repo) =>
    fetchManifestVersion(String(repo))
  );
  ipcMain.handle("plugins:trust-list", (_e, force) => fetchTrustList(!!force));
  ipcMain.handle("plugins:uninstall", (_e, id) => {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(String(id)))
      throw new Error("Bad extension id");
    const dir = path.join(pluginsDir(), String(id));
    // Retry: on Windows a just-imported bundle can be briefly locked.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    if (fs.existsSync(dir)) throw new Error("Could not delete extension files");
  });
}

// ---------------------------------------------------------------------------
// Native file bridge. Lets the renderer read/write the open project folder by
// absolute path instead of through File System Access handles. Paths don't
// expire across sessions the way FSA permissions do, so the originals reconnect
// on launch with no user gesture (Lightroom-style). Trust scope: the renderer
// only ever loads our own bundle (navigation is locked to app://), so exposing
// fs by path is the same trust level the app already runs at.
// ---------------------------------------------------------------------------
function registerFsIpc() {
  ipcMain.handle("fs:read", async (_e, p) => {
    const st = await fs.promises.stat(p);
    const data = await fs.promises.readFile(p); // Buffer → Uint8Array in renderer
    return { data, mtimeMs: st.mtimeMs, size: st.size };
  });
  ipcMain.handle("fs:write", async (_e, p, data) => {
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    // Atomic write: write to a temp sibling, then rename over the target. A
    // crash/quit mid-write leaves the existing file intact (rename is atomic on
    // the same filesystem), so an interrupted save — e.g. the fire-and-forget
    // beforeunload catalog flush on app quit — can never truncate catalog.json
    // and trigger a spurious full re-import on the next launch.
    const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
    try {
      await fs.promises.writeFile(tmp, Buffer.from(data));
      await fs.promises.rename(tmp, p);
    } catch (err) {
      await fs.promises.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  });
  ipcMain.handle("fs:list", async (_e, p) => {
    let ents;
    try {
      ents = await fs.promises.readdir(p, { withFileTypes: true });
    } catch (e) {
      if (e && e.code === "ENOENT") return []; // missing dir → empty, like FSA
      throw e;
    }
    return ents.map((d) => ({
      name: d.name,
      kind: d.isDirectory() ? "directory" : "file",
    }));
  });
  ipcMain.handle("fs:mkdir", async (_e, p) => {
    await fs.promises.mkdir(p, { recursive: true });
  });
  ipcMain.handle("fs:remove", async (_e, p) => {
    await fs.promises.rm(p, { recursive: true, force: true });
  });
  // Move/rename a file or directory. Used by folder-ops for drag-to-reorganise
  // and folder rename; one rename handles a whole subtree atomically.
  ipcMain.handle("fs:move", async (_e, src, dest) => {
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.rename(src, dest);
  });
  ipcMain.handle("fs:exists", async (_e, p) => {
    try {
      await fs.promises.access(p);
      return true;
    } catch {
      return false;
    }
  });
  ipcMain.handle("fs:pickDirectory", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ["openDirectory"],
    });
    return canceled || !filePaths[0] ? null : filePaths[0];
  });
}

// ---------------------------------------------------------------------------
// Developer Tools extension bridge. Lets the (opt-in, disabled-by-default)
// Developer Tools panel drive the window's Chrome DevTools and read main-process
// diagnostics. Gated by the renderer: the panel only exists when the user
// enables the extension.
// ---------------------------------------------------------------------------
function registerDevtoolsIpc() {
  const senderWindow = (e) => BrowserWindow.fromWebContents(e.sender);
  const DEVTOOLS_MODES = new Set(["right", "bottom", "undocked", "detach"]);

  ipcMain.handle("devtools:open", (e, mode) => {
    const wc = senderWindow(e)?.webContents;
    if (wc) wc.openDevTools({ mode: DEVTOOLS_MODES.has(mode) ? mode : "detach" });
  });
  ipcMain.handle("devtools:close", (e) => senderWindow(e)?.webContents.closeDevTools());
  ipcMain.handle("devtools:toggle", (e) => {
    const wc = senderWindow(e)?.webContents;
    if (!wc) return;
    if (wc.isDevToolsOpened()) wc.closeDevTools();
    else wc.openDevTools({ mode: "detach" });
  });
  ipcMain.handle("devtools:isOpen", (e) => !!senderWindow(e)?.webContents.isDevToolsOpened());
  ipcMain.handle("devtools:reload", (e, hard) => {
    const wc = senderWindow(e)?.webContents;
    if (!wc) return;
    if (hard) wc.reloadIgnoringCache();
    else wc.reload();
  });

  ipcMain.handle("diagnostics:gpuInfo", () => app.getGPUFeatureStatus());
  ipcMain.handle("diagnostics:metrics", () =>
    app.getAppMetrics().map((m) => ({
      type: m.type,
      pid: m.pid,
      cpuPercent: m.cpu ? m.cpu.percentCPUUsage : 0,
      // workingSetSize is reported in kilobytes.
      memoryMB: m.memory ? m.memory.workingSetSize / 1024 : 0,
    }))
  );
}

// The custom in-app top bars (TopBar, welcome, DevTools — all h-[38px]) double
// as the window title bar via titleBarStyle:'hidden'. On Windows/Linux the
// native min/max/close buttons are drawn as an overlay on the right (keeps
// Windows snap-layout-on-hover); on macOS the traffic lights stay on the left as
// Mac users expect — we only nudge them to vertically center within the bar.
// The overlay is kept 2px shorter than the bar so the bar's bottom border line
// stays visible beneath the buttons. Overlay colors are recolored per-surface at
// runtime by useTitleBarOverlay (src/ui/window-chrome.ts); these are first-paint
// defaults matching the neutral theme's surface-1.
const titleBarOpts =
  process.platform === "darwin"
    ? { titleBarStyle: "hidden", trafficLightPosition: { x: 12, y: 12 } }
    : {
        titleBarStyle: "hidden",
        titleBarOverlay: {
          color: "#5e5e5e", // --color-surface-1
          symbolColor: "#d0d0d0", // --color-text-secondary
          height: 36, // 2px under the 38px bar so its bottom border shows
        },
      };

function createWindow() {
  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#1a1a1a",
    show: false,
    autoHideMenuBar: true,
    ...titleBarOpts,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Enabled in packaged builds too so the opt-in Developer Tools extension
      // can open DevTools; it never auto-opens outside dev (see below).
      devTools: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  win.once("ready-to-show", () => win.show());

  // Detached windows (shortcuts, loupe, etc.): defer show until ready-to-show
  // to avoid black frames on macOS — same pattern as the main window.
  win.webContents.on("did-create-window", (childWin) => {
    childWin.once("ready-to-show", () => childWin.show());
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    // Internal windows = detachable modules (window.open to an app:// URL).
    // Allow them as native child windows with the same isolation settings so
    // the custom-protocol origin, preload, and COOP/COEP all carry over and
    // BroadcastChannel sync keeps working.
    if (url.startsWith("app://")) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          show: false,
          backgroundColor: "#1a1a1a",
          autoHideMenuBar: true,
          ...titleBarOpts,
          webPreferences: {
            preload: path.join(__dirname, "preload.cjs"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            devTools: true,
            backgroundThrottling: false,
          },
        },
      };
    }
    // External links → system browser, never in-app.
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  win.loadURL("app://bundle/index.html");
  if (isDev) win.webContents.openDevTools({ mode: "detach" });
  return win;
}

// Single instance — focus existing window instead of launching a second copy.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  // Lock every webContents (main + detached module windows) to the bundled
  // app: in-page navigation may only target app://, anything http(s) goes to
  // the system browser. Stops extensions/markdown links from hijacking a window.
  app.on("web-contents-created", (_e, contents) => {
    contents.on("will-navigate", (event, url) => {
      if (!url.startsWith("app://")) {
        event.preventDefault();
        if (/^https?:\/\//.test(url)) shell.openExternal(url);
      }
    });
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    // Permissions: the File System Access API (Open Folder / Reconnect
    // originals) must be granted or showDirectoryPicker/requestPermission
    // silently fail. Everything else (camera, mic, geolocation, ...) is denied.
    const ALLOWED_PERMISSIONS = new Set([
      "fileSystem", // File System Access API (Electron's name)
      "file-system-access", // older/alternate name, kept for safety
      "clipboard-sanitized-write", // navigator.clipboard.writeText
      "persistent-storage", // keep IndexedDB (project handles, cache) from eviction
    ]);
    // requestPermission() — needs a user gesture (the Reconnect button / Open
    // Folder click). Governs the browser-style re-grant path.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) =>
      cb(ALLOWED_PERMISSIONS.has(permission))
    );
    // queryPermission() — synchronous, no gesture. Without this, a project
    // handle restored from IndexedDB reports "prompt" on every cold start, so
    // openLast() can't re-verify silently and the app falls back to the click.
    // Granting "fileSystem" here lets queryPermission resolve "granted" up front:
    // in Electron the originals reconnect automatically (Lightroom-style), and
    // the click path is left as pure error-recovery for moved/missing files.
    session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
      ALLOWED_PERMISSIONS.has(permission)
    );
    registerProtocol();
    registerPluginIpc();
    registerFsIpc();
    registerDevtoolsIpc();
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
