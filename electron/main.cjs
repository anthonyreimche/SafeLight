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
  screen,
  session,
  dialog,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { isRuntimeGpuCrash, isRendererCrash, createRecoveryGate } = require("./crash-recovery.cjs");
const {
  replacePlugin,
  settlePlugin,
  sweepPluginWork,
  contains,
  retry,
} = require("./plugin-files.cjs");
const { createAtomicWriter } = require("./atomic-write.cjs");
const {
  validManifest,
  listInstalledManifests,
  listDevManifests,
  declaredConnectHosts,
  pendingConnectHosts,
  readDevFolder,
  writeDevFolder,
} = require("./extension-origins.cjs");
const { createRemoteJsonCache } = require("./remote-json-cache.cjs");
const {
  navigationAllowed,
  windowOpenAction,
  indexRedirectFor,
  guardPrivileged,
  validRepo,
} = require("./window-policy.cjs");
const { pruneExpired, usableIndex } = require("./registry-cache.cjs");
const { unzip } = require("./unzip.cjs");
const {
  checkInstallFiles,
  compareSemver,
  createReleaseListCache,
  downloadReleaseFiles,
  findRelease,
  isSemver,
  mustContainFor,
  normaliseReleases,
  parseRegistryVersions,
  rateLimitMessage,
  remoteFromRegistry,
  remoteFromReleases,
  resolveInstallSource,
  safeEntries,
} = require("./plugin-releases.cjs");

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
  //   4. A runtime GPU crash (window already visible) is not the probe's
  //      business — the mid-session crash-recovery handlers reload the
  //      affected windows instead.
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
// Privacy: Safelight ships no telemetry of its own. Belt-and-suspenders, turn off
// Chromium's own background network services so no component-update or
// domain-reliability traffic leaves the machine without an explicit user action.
app.commandLine.appendSwitch("disable-domain-reliability");
app.commandLine.appendSwitch("disable-component-update");
app.commandLine.appendSwitch("disable-features", "Translate,MediaRouter,OptimizationHints");

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
// Origins extensions may fetch (XHR/fetch). Extensions that talk to a backend —
// e.g. the Web Tools gallery service — need this; without it they can't reach any
// network and have to shell out to a helper process. Cloudflare Workers are
// allowed by default; SAFELIGHT_GALLERY_ORIGINS (space-separated) adds custom
// origins (e.g. a galleries.yourdomain.com Worker route). script-src stays 'self'
// so this widens data egress to these hosts only, never code execution.
const galleryOrigins = process.env.SAFELIGHT_GALLERY_ORIGINS || "https://*.workers.dev";

const CSP_STATIC = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' blob:",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  // https: lets the Extensions store show remote previews: repo thumbnails,
  // owner avatars, and images inside rendered extension READMEs (badges,
  // screenshots), and gallery thumbnails from a backend. Images can't execute
  // code, so this widens display only.
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-src 'none'",
];

// connect-src is built from 'self' + the gallery origins + the HTTPS origins that
// extensions DECLARE in their manifest's permissions.network: the installed ones
// under userData/plugins and, read the same way, those in the Developer Tools dev
// folder (extension-origins.cjs). Only declared (and therefore user-visible)
// origins widen the policy, so an extension can't silently fetch an arbitrary
// host — anything not declared is blocked by the CSP. The set is computed once
// per launch from the manifests on disk; a newly-installed extension's origins,
// or a newly chosen dev folder's, take effect on the next launch (a natural
// consent point). Malformed entries never reach the policy, so a manifest can't
// inject 'unsafe-eval', a data: source, or a bare * into it.
let launchHosts = null;
function extensionConnectHosts() {
  if (!launchHosts)
    launchHosts = declaredConnectHosts([
      ...listPlugins(),
      ...listDevManifests(readDevFolder(devFolderFile())),
    ]);
  return launchHosts;
}
let cspCache = null;
function buildCSP() {
  if (cspCache) return cspCache;
  const connect = ["'self'", "data:", "blob:", galleryOrigins, ...extensionConnectHosts()];
  cspCache = [...CSP_STATIC, `connect-src ${connect.join(" ")}`].join("; ");
  return cspCache;
}

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
  if (!contains(DIST, filePath)) filePath = path.join(DIST, "index.html");
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
      if (!contains(pluginsDir(), filePath) || !fs.existsSync(filePath)) {
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
    if (type === "text/html") headers.set("Content-Security-Policy", buildCSP());
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
// Work area for in-flight installs/updates (see plugin-files.cjs): beside
// plugins/, never inside it.
const pluginWorkDir = () => path.join(app.getPath("userData"), "plugins-update");
// The Developer Tools dev folder as the renderer last recorded it, so the next
// launch reads its manifests for the CSP the way it reads the installed ones.
const devFolderFile = () => path.join(app.getPath("userData"), "dev-folder.json");

// True when this app build is older than the extension's declared minimum
// supported version, by semver precedence (plugin-releases.cjs mirrors the
// renderer's helper). A too-old install is refused before any files are
// written; the renderer can't know minAppVersion until the manifest lands.
function appOlderThan(minVersion) {
  return compareSemver(appVersion(), minVersion) < 0;
}

function listPlugins() {
  return listInstalledManifests(pluginsDir());
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

// spec: "owner/repo", "owner/repo#ref", or a github.com URL. `ref` is null when
// the spec names none; the install then resolves a release (or the branch).
function parseRepoSpec(spec) {
  let s = String(spec).trim();
  const url = s.match(
    /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s#]+?)(?:\.git)?(?:\/tree\/([^\s]+))?\/?$/
  );
  if (url) return { owner: url[1], repo: url[2], ref: url[3] || null };
  const [repoPart, ref] = s.split("#");
  const m = repoPart.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!m) throw new Error("Use owner/repo, owner/repo#branch, or a GitHub URL");
  return { owner: m[1], repo: m[2], ref: ref || null };
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
const EMPTY_TRUST = { verified: [], reviewed: {}, repos: [], owners: [], reason: {} };
let trustCache = null; // { at, list }

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

// ── Extension releases ───────────────────────────────────────────────────────
// An extension installs from its newest GitHub Release, or from its default
// branch when it publishes none (plugin-releases.cjs decides which). Versions
// come from the registry index whenever it lists the repo, so update checks
// cost no API call; release lists are read from the API only when the store
// shows them or an older version is installed, and are kept on disk.

// Total time a release zip or tarball download may take, body included. Generous
// for a slow link, but a dead connection ends the install instead of hanging it.
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

// The codeload tarball of `ref`, unpacked, with GitHub's "<repo>-<ref>/" folder
// stripped and unsafe names dropped.
async function fetchTarballFiles(owner, repo, ref) {
  const tarUrl = `https://codeload.github.com/${owner}/${repo}/tar.gz/${encodeURIComponent(ref)}`;
  const res = await net.fetch(tarUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GitHub download failed (${res.status})`);
  const tar = zlib.gunzipSync(Buffer.from(await res.arrayBuffer()));
  return safeEntries(
    untar(tar).map((f) => ({ ...f, name: f.name.split("/").slice(1).join("/") }))
  );
}

async function fetchBuffer(url) {
  const res = await net.fetch(url, {
    headers: { "User-Agent": "Safelight" },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

// safelight.json at `ref` (a tag, or HEAD) from GitHub's file CDN, which the API
// rate limit doesn't cover. Null when the file is missing or isn't JSON; any
// other failure rejects so callers keep what they had.
async function fetchManifestAt(repo, ref) {
  // AbortSignal.timeout, unlike fetchWithTimeout's timer, stays armed while the
  // body is read, so a stalled body can't hang the caller.
  const res = await net.fetch(
    `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref)}/safelight.json`,
    {
      headers: { "User-Agent": "Safelight", Accept: "application/json" },
      cache: "no-cache",
      signal: AbortSignal.timeout(10000),
    }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub error: ${res.status}`);
  // Read before parsing so a timeout mid-body rejects rather than reading as
  // "no manifest".
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function fetchReleaseListLive(repo) {
  const res = await net.fetch(`https://api.github.com/repos/${repo}/releases?per_page=30`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "Safelight" },
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(rateLimitMessage(res.status, res.headers, repo));
  return normaliseReleases(await res.json(), repo);
}

const releaseListFile = () => path.join(app.getPath("userData"), "extension-releases.json");
const releaseLists = createReleaseListCache({
  load: () => {
    try {
      return JSON.parse(fs.readFileSync(releaseListFile(), "utf8"));
    } catch {
      return null;
    }
  },
  save: (map) => {
    fileWriter.write(releaseListFile(), JSON.stringify(map)).catch(() => {});
  },
  fetchList: fetchReleaseListLive,
  ttlMs: 6 * 60 * 60 * 1000,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
});

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

async function installPlugin(spec, version) {
  const { owner, repo, ref } = parseRepoSpec(spec);
  // parseRepoSpec only splits the spec; a name GitHub could resolve differently
  // than banned.json spells it (owner/rep%6f) must not reach the gate or a fetch.
  if (!validRepo(`${owner}/${repo}`)) throw new Error("Bad repository");
  if (version !== undefined && (ref || !isSemver(version)))
    throw new Error(ref ? "Install a branch or a version, not both" : "Bad version");
  // Remote kill-switch: refuse banned repos/owners before any download or write.
  // The renderer enforces this too (nicer UX), but this is the authoritative
  // gate — it holds even if the renderer bundle is tampered with.
  const banned = bannedReason(await fetchTrustList(), owner, repo);
  if (banned)
    throw new Error(`"${owner}/${repo}" is blocked by Safelight — ${banned}.`);
  const full = `${owner}/${repo}`;
  let files;
  let release = null;
  let origin = "the repo";
  let skipped = [];
  if (ref) {
    files = await fetchTarballFiles(owner, repo, ref);
  } else {
    const registry = await registryVersionsFor(full);
    const source = await resolveInstallSource({
      repo: full,
      version,
      registry,
      releaseList: () => releaseLists.get(full, { mustContain: mustContainFor(registry) }),
    });
    if (source.kind === "branch") {
      files = await fetchTarballFiles(owner, repo, "HEAD");
    } else {
      release = source.release;
      ({ files, origin, skipped } = await downloadReleaseFiles({
        release,
        fetchBuffer,
        readTarball: (tag) => fetchTarballFiles(owner, repo, tag),
        unzip,
      }));
    }
  }
  const manifest = checkInstallFiles(files, {
    repo: full,
    release,
    origin,
    skipped,
    appOlderThan,
    appVersion: appVersion(),
  });
  if (!contains(pluginsDir(), path.join(pluginsDir(), manifest.id)))
    throw new Error("Bad extension id");
  // Atomic: the files land in a work folder first, and the current install is
  // kept aside as prev until the renderer settles the update (plugin-files.cjs).
  await replacePlugin({
    pluginsDir: pluginsDir(),
    workDir: pluginWorkDir(),
    id: manifest.id,
    files,
  });
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
// fall back to the cached payload while one is still held, even past its TTL,
// rather than surfacing an error.
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
    fs.promises
      .writeFile(searchCacheFile(), JSON.stringify(Object.fromEntries(searchCache)))
      .catch(() => {});
  }, 1000);
  if (searchWriteTimer.unref) searchWriteTimer.unref();
}

// ── Prebuilt registry index ──────────────────────────────────────────────────
// A static catalog of every published extension, regenerated server-side by a
// GitHub Action in the registry repo (TRUST_REGISTRY) and committed as
// registry.json. The store fetches this ONE CDN-cached file instead of running a
// live GitHub Search + a per-card icon/og resolution on every machine: one
// request, no API rate limit, the COMPLETE catalog (not the search endpoint's
// first page of 25), and the thumbnails already resolved. This is how the store
// loads the full list fast; searchExtensionsLive stays as the fallback.
const DEFAULT_EXT_TOPIC = "safelight-extension";
const REGISTRY_INDEX_TTL_MS = 60 * 60 * 1000; // catalog turns over slowly; 1h
let registryIndexCache = null; // { at, items } | null
const registryIndexFile = () =>
  path.join(app.getPath("userData"), "registry-index.json");
let registryIndexLoaded = false;

function loadRegistryDisk() {
  if (registryIndexLoaded) return;
  registryIndexLoaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(registryIndexFile(), "utf8"));
    if (raw && typeof raw.at === "number" && Array.isArray(raw.items))
      registryIndexCache = { at: raw.at, items: raw.items };
  } catch {}
}

let registryWriteTimer = null;
function persistRegistryDisk() {
  if (registryWriteTimer) return;
  registryWriteTimer = setTimeout(() => {
    registryWriteTimer = null;
    fs.promises
      .writeFile(registryIndexFile(), JSON.stringify(registryIndexCache))
      .catch(() => {});
  }, 1000);
  if (registryWriteTimer.unref) registryWriteTimer.unref();
}

// Normalise one registry.json row into the ExtensionSearchResult shape the
// renderer already consumes. Tolerant of partial/garbage rows (drops them) so a
// single malformed entry can never break the whole grid. A row with no usable
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
    topics: Array.isArray(e.topics)
      ? e.topics.filter((t) => typeof t === "string")
      : [],
    avatarUrl,
    thumbnail: thumb || { url: avatarFor(e.fullName, avatarUrl), custom: false },
    source: "registry",
    versions: parseRegistryVersions(e),
  };
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
    registryIndexCache = { at: Date.now(), items };
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

// Client-side query filter over the registry index — substring match on
// "owner/repo", description and topics. Mirrors what `topic:… <query>` would do on
// the Search API, but instantly and offline (the index is already the topic set).
function filterRegistry(items, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return items;
  return items.filter(
    (it) =>
      it.fullName.toLowerCase().includes(q) ||
      (it.description && it.description.toLowerCase().includes(q)) ||
      (it.topics || []).some((t) => String(t).toLowerCase().includes(q)),
  );
}

// The welcome setup's starter kits: curated groups of verified extensions,
// published as kits.json beside registry.json so they change without an app
// release. Same CDN and cache discipline as the registry index (raw, never
// jsDelivr, `cache: "no-cache"` so the 1h TTL is the only clock).
const kitsIndex = createRemoteJsonCache({
  url: `https://raw.githubusercontent.com/${TRUST_REGISTRY}/main/kits.json`,
  cacheFile: () => path.join(app.getPath("userData"), "kits-cache.json"),
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
// index (one CDN fetch, the whole catalog, thumbnails already baked); a custom
// topic — or an index that isn't reachable / published yet — falls back to a live
// GitHub Search. Keeping both paths means the store never regresses for users on a
// custom topic and degrades gracefully if the registry repo is down.
async function searchExtensions(query, topic, force = false) {
  const t = String(topic || DEFAULT_EXT_TOPIC).trim();
  if (t === DEFAULT_EXT_TOPIC) {
    const index = await fetchRegistryIndex(force);
    // Zip asset lists stay in main: registryVersionsFor reads them from the
    // cached index, the renderer only needs the card fields.
    if (usableIndex(index))
      return filterRegistry(index, query).map(({ versions, ...item }) => item);
  }
  return searchExtensionsLive(query, topic, force);
}

async function fetchReleases(repo) {
  if (!validRepo(repo)) throw new Error("Bad repository");
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

// The newest version a repo publishes, with its minAppVersion, for the update
// check: the registry's record when it lists the repo, else the repo's own
// release list (or its branch manifest when it has none). Null when there is
// nothing to offer. A network failure or API error rejects instead, so the
// renderer keeps its last record rather than forgetting a pending update — or a
// version that already failed to start here.
async function fetchRemoteManifest(repo, opts) {
  if (!validRepo(repo)) return null;
  const prerelease = !!(opts && opts.prerelease);
  const registry = await registryVersionsFor(repo);
  if (registry) return remoteFromRegistry(registry, prerelease);
  return remoteFromReleases({
    list: await releaseLists.get(repo),
    prerelease,
    manifestAt: (tag) => fetchManifestAt(repo, tag),
    branchManifest: () => fetchManifestAt(repo, "HEAD"),
  });
}

// A repo's releases for the store's version picker and release notes, without
// the download URLs. A branch source the registry lists answers [] without an
// API call, unless `force` (the store's ↻) asks GitHub whether it has just
// published its first release.
async function fetchReleasesForStore(repo, force) {
  if (!validRepo(repo)) throw new Error("Bad repository");
  const registry = await registryVersionsFor(repo);
  if (registry && registry.releaseError) throw new Error(registry.releaseError);
  if (registry && registry.latest.from === "branch" && !force) return [];
  const list = await releaseLists.get(repo, { force, mustContain: mustContainFor(registry) });
  return list.map(({ zips, ...release }) => release);
}

// safelight.json at the tag of `version`, so the store can say a chosen
// release needs a newer Safelight (or is broken) before trying it.
async function fetchReleaseManifest(repo, version) {
  if (!validRepo(repo) || !isSemver(version)) return null;
  const registry = await registryVersionsFor(repo);
  const named =
    registry && registry.latest
      ? [registry.latest, registry.prerelease].find(
          (r) => r && r.tag && compareSemver(r.version, version) === 0
        )
      : null;
  let tag = named ? named.tag : null;
  if (!tag) {
    const list = await releaseLists.get(repo, { mustContain: mustContainFor(registry) });
    const hit = findRelease(list, version);
    if (!hit) return null;
    tag = hit.tag;
  }
  const m = await fetchManifestAt(repo, tag);
  if (!m || typeof m.version !== "string") return null;
  return typeof m.minAppVersion === "string"
    ? { version: m.version, minAppVersion: m.minAppVersion }
    : { version: m.version };
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
  if (!validRepo(repo)) throw new Error("Bad repository");
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

// Each webContents' committed main-frame URL, recorded on did-navigate in
// web-contents-created. The privileged guard judges this rather than
// frame.url, which history.pushState moves without loading a document.
const committedUrls = new WeakMap();

// The channels behind claimPrivileged (fs:*, updates:install) answer only the
// app's own top-level document; see window-policy.cjs.
function handlePrivileged(channel, handler) {
  ipcMain.handle(channel, guardPrivileged(channel, handler, { committedUrls }));
}

function registerPluginIpc() {
  // Nothing is in flight before the first window: a previous version still in
  // the work area belongs to an update that was never settled, so it goes back.
  sweepPluginWork({ pluginsDir: pluginsDir(), workDir: pluginWorkDir() });
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
  handlePrivileged("updates:install", (_e, repo, tag) =>
    installRelease(String(repo), String(tag))
  );
  ipcMain.handle("plugins:list", () => listPlugins());
  ipcMain.handle("plugins:install", (_e, spec, version) =>
    installPlugin(spec, version == null ? undefined : String(version))
  );
  ipcMain.handle("plugins:search", (_e, query, topic, force) =>
    searchExtensions(query, topic, force)
  );
  ipcMain.handle("plugins:remote-manifest", (_e, repo, opts) =>
    fetchRemoteManifest(String(repo), { prerelease: !!(opts && opts.prerelease) })
  );
  ipcMain.handle("plugins:releases", (_e, repo, force) =>
    fetchReleasesForStore(String(repo), !!force)
  );
  ipcMain.handle("plugins:manifest-at", (_e, repo, version) =>
    fetchReleaseManifest(String(repo), String(version))
  );
  ipcMain.handle("plugins:settle-update", async (_e, id, outcome) => {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(String(id)))
      throw new Error("Bad extension id");
    if (outcome !== "keep" && outcome !== "rollback")
      throw new Error("Bad update outcome");
    const restored = await settlePlugin({
      pluginsDir: pluginsDir(),
      workDir: pluginWorkDir(),
      id: String(id),
      outcome,
    });
    // A restored copy that no longer parses is one listPlugins would skip too.
    return restored && validManifest(restored) ? restored : null;
  });
  ipcMain.handle("plugins:trust-list", (_e, force) => fetchTrustList(!!force));
  ipcMain.handle("plugins:kits", (_e, force) => kitsIndex.get(!!force));
  ipcMain.handle("plugins:uninstall", (_e, id) => {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(String(id)))
      throw new Error("Bad extension id");
    const dir = path.join(pluginsDir(), String(id));
    // Retry: on Windows a just-imported bundle can be briefly locked.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    if (fs.existsSync(dir)) throw new Error("Could not delete extension files");
  });
}

// Base directory for "separate" catalogs: the user's override if set, else a
// stable folder under the app's userData. Shared by the resolve + list handlers
// so they always agree on where catalogs live.
function externalCatalogBase(baseOverride) {
  return baseOverride && String(baseOverride).trim()
    ? path.resolve(String(baseOverride))
    : path.join(app.getPath("userData"), "external-catalogs");
}

// Where the per-source "spillover pointer" lives: a tiny file recording which
// separate catalog a read-only source spilled into. Kept under the app-data
// DEFAULT (never the user's chosen base) and keyed by a hash of the source path,
// so a later writeable open finds the spillover to fold back regardless of which
// "Separate catalog location" is configured at that time. One file per source →
// no shared-index contention; writes are atomic (temp + rename).
function spilloverPointerPath(rootPath) {
  const src = path.resolve(String(rootPath));
  const tag = crypto.createHash("sha1").update(src).digest("hex");
  return path.join(app.getPath("userData"), "external-catalogs", ".pointers", `${tag}.json`);
}

// Recursive size of a directory in bytes. Best-effort: symlinks aren't followed
// (lstat) so it can't loop, and any unreadable entry is skipped. Used on demand
// by the Stored-catalogs manager, never on a hot path.
async function dirSizeBytes(dir) {
  let total = 0;
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += await dirSizeBytes(p);
      else if (e.isFile()) total += (await fs.promises.lstat(p)).size;
    } catch {
      /* skip unreadable entry */
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Native file bridge. Lets the renderer read/write the open project folder by
// absolute path instead of through File System Access handles. Paths don't
// expire across sessions the way FSA permissions do, so the originals reconnect
// on launch with no user gesture (Lightroom-style). Trust scope: windows only
// ever hold the app's own index (window-policy.cjs), and every fs:* call is
// refused unless it comes from such a document's top frame.
// ---------------------------------------------------------------------------
// Shared by every window so writes to one file stay ordered; drained on quit.
const fileWriter = createAtomicWriter({
  fsp: fs.promises,
  randomId: () => crypto.randomBytes(8).toString("hex"),
  retry,
});

function registerFsIpc() {
  handlePrivileged("fs:read", async (_e, p) => {
    const st = await fs.promises.stat(p);
    const data = await fs.promises.readFile(p); // Buffer → Uint8Array in renderer
    return { data, mtimeMs: st.mtimeMs, size: st.size };
  });
  // Atomic, ordered per file (atomic-write.cjs). The write is queued before the
  // handler returns, so a window's last flush is already pending at will-quit.
  handlePrivileged("fs:write", (_e, p, data) =>
    fileWriter.write(p, data instanceof Uint8Array ? data : Buffer.from(data)),
  );
  handlePrivileged("fs:list", async (_e, p) => {
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
  handlePrivileged("fs:mkdir", async (_e, p) => {
    await fs.promises.mkdir(p, { recursive: true });
  });
  // Resolve a "separate" .safelight working directory for a project folder — used
  // when the source can't host its own (a read-only memory card) or when the user
  // picked "Separate folder" in Preferences. The catalog/previews/RAW cache live
  // here instead, under `baseOverride` if set, otherwise under the app's userData.
  // Keyed by a hash of the source path so every folder keeps its own stable
  // catalog and two folders at different paths never collide.
  //   create === false → existence probe: returns the dir iff a catalog already
  //     lives here (so a redirected source keeps its catalog instead of being
  //     orphaned when it later becomes writeable), else null. Creates nothing.
  //   create !== false → creates the directory (so a write failure surfaces, e.g.
  //     an unwriteable override) and returns its absolute path. Idempotent: an
  //     existing catalog is left untouched.
  handlePrivileged("fs:externalCatalogDir", async (_e, rootPath, baseOverride, create) => {
    const src = path.resolve(String(rootPath));
    const base = externalCatalogBase(baseOverride);
    const tag = crypto.createHash("sha1").update(src).digest("hex").slice(0, 8);
    const leaf =
      path.basename(src).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 40) || "folder";
    const parent = path.join(base, `${leaf}-${tag}`);
    const dir = path.join(parent, ".safelight");
    if (create === false) {
      try {
        await fs.promises.access(path.join(dir, "catalog.json"));
        return dir;
      } catch {
        return null;
      }
    }
    await fs.promises.mkdir(dir, { recursive: true });
    // Record the source path (once) so the "Stored catalogs" manager can show
    // which folder an orphaned catalog belonged to — the tag is a one-way hash.
    const meta = path.join(parent, "source.json");
    try {
      await fs.promises.access(meta);
    } catch {
      await fs.promises
        .writeFile(meta, JSON.stringify({ source: src, createdAt: Date.now() }))
        .catch(() => {});
    }
    return dir;
  });
  // Enumerate the "separate" catalogs under `baseOverride` (or the app data dir)
  // for the Preferences manager: each entry is a per-source folder the user can
  // reveal or delete to reclaim disk. Best-effort — unreadable entries are skipped.
  handlePrivileged("fs:listExternalCatalogs", async (_e, baseOverride) => {
    const base = externalCatalogBase(baseOverride);
    let entries;
    try {
      entries = await fs.promises.readdir(base, { withFileTypes: true });
    } catch {
      return []; // base doesn't exist yet → nothing stored
    }
    const out = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      // Only ever list folders Safelight itself created — a "<slug>-<8 hex>" leaf
      // (see the keying above) that holds a .safelight working dir. Without this,
      // a user who points the base at one of their own directories would see its
      // unrelated subfolders listed as deletable "catalogs", and the delete button
      // (fs:remove → rm -rf) would wipe them. The filter makes that impossible.
      if (!/-[0-9a-f]{8}$/.test(e.name)) continue;
      const dir = path.join(base, e.name);
      try {
        if (!(await fs.promises.stat(path.join(dir, ".safelight"))).isDirectory()) continue;
      } catch {
        continue; // no .safelight subdir → not one of ours
      }
      let sourcePath = null;
      let createdAt = null;
      try {
        const meta = JSON.parse(
          await fs.promises.readFile(path.join(dir, "source.json"), "utf8"),
        );
        sourcePath = typeof meta.source === "string" ? meta.source : null;
        createdAt = typeof meta.createdAt === "number" ? meta.createdAt : null;
      } catch {
        /* pre-source.json catalog, or unreadable meta — leave nulls */
      }
      let mtimeMs = 0;
      try {
        mtimeMs = (await fs.promises.stat(dir)).mtimeMs;
      } catch {
        /* ignore */
      }
      const bytes = await dirSizeBytes(dir).catch(() => 0);
      out.push({ path: dir, name: e.name, sourcePath, createdAt, bytes, mtimeMs });
    }
    return out;
  });
  // Record where a source's read-only spillover catalog lives (atomic write).
  handlePrivileged("fs:setSpilloverPointer", async (_e, rootPath, spilloverDir) => {
    const p = spilloverPointerPath(rootPath);
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    const body = JSON.stringify({
      source: path.resolve(String(rootPath)),
      spillover: String(spilloverDir),
    });
    // Random suffix so two same-source writers in the same millisecond can't share
    // a tmp path (the loser's rename would ENOENT); both write identical content.
    const tmp = `${p}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    await fs.promises.writeFile(tmp, body);
    await fs.promises.rename(tmp, p);
  });
  // Look up a source's spillover dir, or null. Verifies the recorded source path
  // matches so a (truncated-hash) collision can't return another source's catalog.
  handlePrivileged("fs:getSpilloverPointer", async (_e, rootPath) => {
    try {
      const meta = JSON.parse(
        await fs.promises.readFile(spilloverPointerPath(rootPath), "utf8"),
      );
      if (
        meta &&
        meta.source === path.resolve(String(rootPath)) &&
        typeof meta.spillover === "string"
      )
        return meta.spillover;
    } catch {
      /* no pointer */
    }
    return null;
  });
  handlePrivileged("fs:clearSpilloverPointer", async (_e, rootPath) => {
    await fs.promises.rm(spilloverPointerPath(rootPath), { force: true });
  });
  handlePrivileged("fs:remove", async (_e, p) => {
    await fs.promises.rm(p, { recursive: true, force: true });
  });
  // Recoverable delete: the OS trash (Recycle Bin) instead of rm. Rejects when
  // the platform can't trash the path (e.g. some network mounts) — the renderer
  // reports that per file rather than falling back to a hard delete.
  handlePrivileged("fs:trash", async (_e, p) => {
    await shell.trashItem(path.normalize(p));
  });
  // Move/rename a file or directory. Used by folder-ops for drag-to-reorganise
  // and folder rename; one rename handles a whole subtree atomically.
  handlePrivileged("fs:move", async (_e, src, dest) => {
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.rename(src, dest);
  });
  handlePrivileged("fs:exists", async (_e, p) => {
    try {
      await fs.promises.access(p);
      return true;
    } catch {
      return false;
    }
  });
  handlePrivileged("fs:pickDirectory", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ["openDirectory"],
    });
    return canceled || !filePaths[0] ? null : filePaths[0];
  });
  // Reveal a path in the OS file manager: open a directory window, or select a
  // file inside its parent folder. Backs Export's "Open Folder" action.
  handlePrivileged("fs:reveal", async (_e, p) => {
    try {
      const st = await fs.promises.stat(p);
      if (st.isDirectory()) {
        // openPath resolves to "" on success, or an error string otherwise.
        return (await shell.openPath(p)) === "";
      }
      shell.showItemInFolder(p);
      return true;
    } catch {
      return false;
    }
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
  // Records the dev folder, so the next launch reads its manifests' declared
  // network origins the way it reads installed extensions' (see
  // extensionConnectHosts), and answers with the origins that folder declares
  // which this launch's policy does not allow yet.
  ipcMain.handle("devtools:sync-dev-folder", (_e, folder) => {
    const f = typeof folder === "string" && folder.trim() ? folder : null;
    writeDevFolder(devFolderFile(), f);
    return {
      pending: pendingConnectHosts(
        declaredConnectHosts(listDevManifests(f)),
        extensionConnectHosts()
      ),
    };
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

// Window geometry survives a restart. Saved bounds are re-validated against the
// displays connected *now*, not the ones that were there on the last quit: a
// window closed on a since-unplugged monitor would otherwise reopen off-screen,
// and a size taken from a larger display would overflow the work area — both
// leave a frame the user cannot drag back.
const DEFAULT_WINDOW = { width: 1500, height: 950 };
const MIN_WINDOW = { width: 900, height: 600 };
const GRAB_MARGIN = 60; // px of frame that must land on a work area to stay grabbable

const windowStateFile = () =>
  path.join(app.getPath("userData"), "window-state.json");

function frameIsReachable(b) {
  return screen.getAllDisplays().some(({ workArea: a }) => {
    const overlapX = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x);
    const titleBarOnScreen = b.y >= a.y && b.y < a.y + a.height - GRAB_MARGIN;
    return overlapX >= GRAB_MARGIN && titleBarOnScreen;
  });
}

// Call only after `ready` — the screen module does not exist before it.
function readWindowState() {
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(windowStateFile(), "utf8"));
  } catch {
    return { ...DEFAULT_WINDOW };
  }
  if (!saved || typeof saved !== "object") return { ...DEFAULT_WINDOW };

  const num = (v) => (Number.isFinite(v) ? v : undefined);
  const state = {
    width: num(saved.width) ?? DEFAULT_WINDOW.width,
    height: num(saved.height) ?? DEFAULT_WINDOW.height,
    x: num(saved.x),
    y: num(saved.y),
    maximized: saved.maximized === true,
    fullScreen: saved.fullScreen === true,
  };

  const positioned = state.x !== undefined && state.y !== undefined;
  const { workArea } = positioned
    ? screen.getDisplayMatching(state)
    : screen.getPrimaryDisplay();
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  state.width = clamp(state.width, MIN_WINDOW.width, workArea.width);
  state.height = clamp(state.height, MIN_WINDOW.height, workArea.height);

  // Clearing x/y hands placement back to Electron, which centres on the primary.
  if (positioned && !frameIsReachable(state)) {
    state.x = undefined;
    state.y = undefined;
  }
  return state;
}

function trackWindowState(win) {
  let timer = null;
  // getNormalBounds, not getBounds: maximising or entering full screen must not
  // overwrite the restored-down geometry that has to come back on the next launch.
  const write = () => {
    const state = {
      ...win.getNormalBounds(),
      maximized: win.isMaximized(),
      fullScreen: win.isFullScreen(),
    };
    try {
      fs.writeFileSync(windowStateFile(), JSON.stringify(state));
    } catch {}
  };
  // Drags fire resize/move continuously; coalesce to one write per gesture on an
  // unref'd timer so a pending save never keeps the app alive.
  const save = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (!win.isDestroyed()) write();
    }, 500);
    if (timer.unref) timer.unref();
  };
  const tracked = [
    "resize",
    "move",
    "maximize",
    "unmaximize",
    "enter-full-screen",
    "leave-full-screen",
  ];
  for (const event of tracked) win.on(event, save);
  // A queued debounce will not survive teardown, so take the last snapshot
  // synchronously while the window still exists.
  win.on("close", () => {
    clearTimeout(timer);
    timer = null;
    write();
  });
}

// window.open policy for every webContents (main window, pop-outs and their
// children). The app's own index opens as a native child with the same
// isolation settings, so the app:// origin, preload and COOP/COEP carry over and
// BroadcastChannel sync keeps working. http(s) goes to the system browser.
// Anything else is denied: an extension's own file opened as a window would be
// a fresh document that could claim the privileged bridge.
function windowOpenHandler({ url }) {
  const action = windowOpenAction(url);
  if (action === "allow-app") {
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
  if (action === "external") shell.openExternal(url);
  return { action: "deny" };
}

function createWindow() {
  const state = readWindowState();
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: MIN_WINDOW.width,
    minHeight: MIN_WINDOW.height,
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

  trackWindowState(win);

  // Restore maximise/full screen here rather than via constructor options:
  // acting on a still-hidden window makes some platforms surface it early,
  // which is the black first frame `show: false` exists to avoid.
  win.once("ready-to-show", () => {
    if (state.fullScreen) win.setFullScreen(true);
    else if (state.maximized) win.maximize();
    win.show();
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

  // Lock every webContents (main window, pop-outs and any children they open)
  // to the app's own index: navigation may only target it, and window.open goes
  // through windowOpenHandler. will-navigate never sees a new window's first
  // load, so a webContents without the open handler could open any URL. http(s)
  // goes to the system browser. Stops extensions/markdown links from hijacking
  // a window.
  app.on("web-contents-created", (_e, contents) => {
    contents.setWindowOpenHandler(windowOpenHandler);
    // Children open hidden (show: false above) to avoid a black first frame;
    // whichever window opened them shows them once painted.
    contents.on("did-create-window", (childWin) => {
      childWin.once("ready-to-show", () => childWin.show());
    });
    contents.on("will-navigate", (event, url) => {
      if (navigationAllowed(url)) return;
      event.preventDefault();
      if (windowOpenAction(url) === "external") shell.openExternal(url);
    });
    // Fires for loads and reloads; pushState fires did-navigate-in-page
    // instead, so this is the document actually in the window. A reload skips
    // will-navigate, so a non-index app:// document is sent back to the index.
    contents.on("did-navigate", (_event, url) => {
      committedUrls.set(contents, url);
      const index = indexRedirectFor(url);
      if (index === null) return;
      console.warn(`[safelight] ${url} is not the app's index; loading ${index}`);
      contents
        .loadURL(index)
        .catch((err) => console.warn(`[safelight] ${index} did not load: ${err.message}`));
    });
  });

  // ── Mid-session crash recovery ────────────────────────────────────────────
  // Virtualized GL drivers (VirtualBox especially) can kill the GPU process
  // under import load. Chromium respawns it, but the app's worker WebGL
  // contexts and the composited surface stay dead — a black, still-draggable
  // window. A reload rebuilds everything from the persisted catalog. Both
  // gates are bounded so a persistently failing GPU degrades to the old
  // restart-by-hand behaviour instead of a reload storm.
  const gpuRecoveryGate = createRecoveryGate();
  app.on("child-process-gone", (_e, details) => {
    const windows = BrowserWindow.getAllWindows();
    if (!isRuntimeGpuCrash(details, windows.length)) return;
    const recover = gpuRecoveryGate.tryRecover();
    console.error(
      `[safelight] GPU process gone (${details.reason}); ` +
        (recover ? `reloading ${windows.length} window(s)` : "recovery budget spent — restart the app"),
    );
    if (recover) for (const win of windows) win.webContents.reload();
  });

  const rendererRecoveryGate = createRecoveryGate();
  app.on("web-contents-created", (_e, contents) => {
    contents.on("render-process-gone", (_ev, details) => {
      if (!isRendererCrash(details) || contents.isDestroyed()) return;
      const recover = rendererRecoveryGate.tryRecover();
      console.error(
        `[safelight] renderer gone (${details.reason}); ` +
          (recover ? "reloading" : "recovery budget spent — restart the app"),
      );
      if (recover) contents.reload();
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

  // Windows send their last catalog flush as they close, which is after
  // before-quit, so the wait for pending writes happens here. Bounded, so a
  // stuck disk can't keep the app from quitting.
  let writesDrained = false;
  app.on("will-quit", async (event) => {
    if (writesDrained || fileWriter.activePaths() === 0) return;
    event.preventDefault();
    writesDrained = true;
    await Promise.race([
      fileWriter.drain(),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    app.quit();
  });
}
