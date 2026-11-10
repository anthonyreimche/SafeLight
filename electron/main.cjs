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
const crypto = require("node:crypto");
const os = require("node:os");
const { readMaterial, windowOptions, writeMaterial } = require("./window-material.cjs");
const {
  isRuntimeGpuCrash,
  isRendererCrash,
  createRecoveryGate,
  createCrashLog,
  isMainFrameLoadFailure,
  restartPrompt,
  RESTART,
} = require("./crash-recovery.cjs");
const {
  SOFTWARE_BACKEND,
  gpuLadder,
  angleSwitches,
  webgl2Lost,
  softwareFallbackFor,
  rendererFallbackFor,
  formatBackendCache,
  parseBackendCache,
  backendState,
  backendCacheFiles,
  retriesHardware,
  startRung,
  readyCache,
  fallbackCache,
  chosenCache,
  relaunchRung,
  relaunchOptions,
} = require("./gpu-backend.cjs");
const { sweepPluginWork, retry } = require("./plugin-files.cjs");
const { createAtomicWriter, writeAtomicSync } = require("./atomic-write.cjs");
const { argvPaths, createRequestOrder, openTargetFor, withoutPaths } = require("./os-open.cjs");
const {
  listInstalledManifests,
  listDevManifests,
  declaredConnectHosts,
  readDevFolder,
} = require("./extension-origins.cjs");
const {
  navigationAllowed,
  windowOpenAction,
  indexRedirectFor,
  guardPrivileged,
} = require("./window-policy.cjs");
const { effectiveMinimum, fitToWorkArea } = require("./window-bounds.cjs");
const { revealWhenReady } = require("./window-reveal.cjs");
const {
  SAFELIGHT_REPO,
  downloadVerified,
  emptyDir,
  fetchWithin,
  launchDownloaded,
  oneAtATime,
  pickAsset,
  selfInstallMethod,
  sha256Digest,
} = require("./self-update.cjs");
const {
  buildCSP,
  galleryOriginsFrom,
  registerAppScheme,
  serveAppProtocol,
} = require("./app-protocol.cjs");
const { createTrustList } = require("./extension-store/trust.cjs");
const { createRegistryIndex, createKitsIndex } = require("./extension-store/registry.cjs");
const { createThumbnails } = require("./extension-store/thumbnails.cjs");
const { createSearch } = require("./extension-store/search.cjs");
const { createReleases } = require("./extension-store/releases.cjs");
const { createInstaller } = require("./extension-store/install.cjs");
const { createRepoInfo } = require("./extension-store/readme.cjs");
const { ipcChannels, registerIpc } = require("./ipc/index.cjs");

// `app.isPackaged` is false when Electron runs an app from a plain directory
// rather than an asar/bundled build — which is exactly how the Nix derivation
// launches us (nixpkgs' own `electron` + our dist/ + electron/). The wrapper
// sets SAFELIGHT_PACKAGED=1 so we still take the packaged code path (no
// auto-DevTools) there. No effect on the electron-builder Win/Mac/Linux builds.
const isDev = !app.isPackaged && process.env.SAFELIGHT_PACKAGED !== "1";
const DIST = path.join(__dirname, "..", "dist");

// Processes that died this launch, for Report an issue.
const crashLog = createCrashLog();

function appVersion() {
  return app.getVersion();
}

// Shared by every window so writes to one file stay ordered; drained on quit.
const fileWriter = createAtomicWriter({
  fsp: fs.promises,
  randomId: () => crypto.randomBytes(8).toString("hex"),
  retry,
});

// ---------------------------------------------------------------------------
// GPU / renderer performance. Must run before app `ready`.
// Without these, packaged Electron on Windows can land on the integrated GPU,
// an old ANGLE backend, or SwiftShader software WebGL — all much slower than
// the same page in Chrome. Match Chrome's fast path explicitly.
// ---------------------------------------------------------------------------
// ANGLE backend auto-detection with persistence, on every platform. The
// ladders are in gpu-backend.cjs: OpenGL, GLES, Vulkan on Linux, D3D11 on
// Windows, Metal on macOS, each ending on SwiftShader software rendering.
//
// appendSwitch must run before app.ready, so GPU failures can't be caught
// inline. Strategy:
//   1. Read the cached backend from userData. If none, start on the first rung.
//   2. If the GPU process fails before any window opens, delete the cache and
//      relaunch immediately with the next rung. The relaunch is invisible to
//      the user.
//   3. On the first launch that survives to app.ready, write the working
//      backend to cache — subsequent cold starts skip the probe entirely.
//   4. A runtime GPU crash (window already open) is not the probe's business —
//      the mid-session crash-recovery handlers reload the affected windows
//      instead.
//   5. A session that loses WebGL2, or spends its GPU crash-recovery budget,
//      writes software to the cache so the next launch draws in software
//      instead of failing again on the backend that merely started. The
//      cache's second line says why, and Preferences turns software on or off
//      for the next launch. Software Safelight chose for itself tries the
//      graphics card again after a while, in case the failure was passing;
//      software the user chose stays.
// ---------------------------------------------------------------------------
// Vulkan + ozone-platform=wayland is incompatible (Chromium warns and may
// crash), so under a native Wayland compositor the Linux ladder has no Vulkan
// and a stale cached "vulkan" from a prior X11 session is ignored.
const isWayland = process.platform === "linux" && !!process.env.WAYLAND_DISPLAY;
const ANGLE_BACKENDS = gpuLadder(process.platform, isWayland);
const userDataDir = () => {
  try {
    return app.getPath("userData");
  } catch {
    return null;
  }
};
const backendCache = backendCacheFiles(userDataDir(), process.platform, process.env);
const readCache = () => {
  for (const file of [backendCache.file, backendCache.legacy]) {
    if (!file) continue;
    try {
      return parseBackendCache(fs.readFileSync(file, "utf8"), ANGLE_BACKENDS);
    } catch { /* not there */ }
  }
  return parseBackendCache("", ANGLE_BACKENDS);
};
const writeCache = (cache) => {
  if (!backendCache.file) return;
  try {
    writeAtomicSync(backendCache.file, formatBackendCache(cache));
    if (backendCache.legacy) fs.rmSync(backendCache.legacy, { force: true });
  } catch { /* non-fatal */ }
};
const clearCache = () => {
  for (const file of [backendCache.file, backendCache.legacy]) {
    if (!file) continue;
    try { fs.rmSync(file, { force: true }); } catch { /* non-fatal */ }
  }
};

const startCache = readCache();
const startedAt = Date.now();
const relaunchIdx = relaunchRung(process.argv);
const angleIdx = startRung(ANGLE_BACKENDS, startCache, relaunchIdx, startedAt, app.getVersion());
const backend = ANGLE_BACKENDS[angleIdx];
if (relaunchIdx === null && retriesHardware(startCache, startedAt, app.getVersion())) {
  console.warn(`[safelight] software rendering (${startCache.reason || "probe"}) is due a retry; trying ANGLE "${backend}"`);
}

for (const [name, value] of angleSwitches(backend)) {
  if (value === undefined) app.commandLine.appendSwitch(name);
  else app.commandLine.appendSwitch(name, value);
}
if (process.platform === "linux") {
  app.commandLine.appendSwitch("disable-gpu-sandbox");
  app.commandLine.appendSwitch("enable-webgl");
  // Native Wayland rendering (no XWayland overhead); auto-detects X11 too.
  app.commandLine.appendSwitch("ozone-platform-hint", "auto");
}

// Persists the working backend once the app reaches ready (GPU confirmed OK),
// keeping why a software launch is in software. Called from the instance that
// holds the single-instance lock, so a second copy that only hands off and
// quits leaves the cache alone. A change made in Preferences this session is
// the next launch's to read, and a pick this session type doesn't offer waits
// for the next session that does.
let fellBack = false;
let userChose = false;
const cacheWorkingBackend = () => {
  if (!fellBack && !userChose && !startCache.elsewhere) writeCache(readyCache(backend, startCache, Date.now()));
};

// Sends the next launch to software once this one proves the GPU path
// unusable. True when that changed where the next launch goes. A renderer that
// couldn't start steps to the next hardware rung first, since another backend
// may link what this one couldn't.
const fallBackToSoftware = (reason, why) => {
  const next = reason === "renderer-failed" ? rendererFallbackFor(ANGLE_BACKENDS, backend) : softwareFallbackFor(backend);
  if (!next || fellBack) return false;
  fellBack = true;
  const software = next === SOFTWARE_BACKEND;
  writeCache(software ? fallbackCache(reason, Date.now(), app.getVersion()) : readyCache(next, startCache, Date.now()));
  console.error(`[safelight] ${why} on ANGLE "${backend}"; the next launch renders ${software ? "in software " : "on "}("${next}")`);
  return true;
};

// Preferences ▸ Rendering ▸ Graphics backend.
const gpuBackendState = () => backendState(backend, readCache(), ANGLE_BACKENDS, Date.now(), app.getVersion());

// Off clears the cache, so the next launch probes the graphics card from the
// first rung; a machine that still fails there falls back again by itself.
const setSoftwareRendering = (on) => {
  if (on) writeCache(fallbackCache("chosen", Date.now()));
  else clearCache();
  userChose = true;
  return gpuBackendState();
};

// Null is Automatic: clearing the cache sends the next launch through the probe
// from the first rung. A pick stays until the user changes it or it fails.
const setGraphicsBackend = (choice) => {
  if (choice === null) clearCache();
  else if (ANGLE_BACKENDS.includes(choice)) writeCache(chosenCache(choice, Date.now(), app.getVersion()));
  else return gpuBackendState();
  userChose = true;
  return gpuBackendState();
};

// WebGL2 started but the develop renderer couldn't be built on it, every retry
// (a driver that can't link Safelight's own shader): no GPU process crashes and
// Chromium keeps reporting WebGL2, so only the renderer can say so. Already in
// software there is nowhere further to go, and no restart is offered.
const rendererFailed = (detail) => {
  if (fallBackToSoftware("renderer-failed", `Develop renderer couldn't start (${detail})`)) offerRestart("gpu");
  return gpuBackendState();
};

// Before the first window opens a failure is the startup probe's to handle.
// macOS keeps running with every window closed, so "no window now" isn't
// "startup".
let windowOpened = false;
app.on("browser-window-created", () => {
  windowOpened = true;
});
// A relaunch is not a second request to open what the OS first asked for.
const relaunchArgv = () => withoutPaths(process.argv, { defaultApp: process.defaultApp });
const relaunchWith = (rung) => relaunchOptions(relaunchArgv(), process.env, rung);
const relaunchOn = (rung) => {
  app.relaunch(relaunchWith(rung));
  app.exit(0);
};

// Chromium reports WebGL2 off once the GPU process can't provide it, or after
// repeated GPU crashes, and Develop can't draw at all from then on. A VM
// retrying the graphics card usually ends here without the GPU process
// crashing, so this session moves to software too rather than staying blank.
app.on("gpu-info-update", () => {
  if (!webgl2Lost(app.getGPUFeatureStatus())) return;
  if (!fallBackToSoftware("webgl2-unavailable", "WebGL2 unavailable")) return;
  if (windowOpened) offerRestart("gpu");
  else relaunchOn(ANGLE_BACKENDS.length - 1);
});

// On GPU process failure at startup: clear the stale cache and relaunch on
// the next rung.
app.on("child-process-gone", (_event, details) => {
  const failReasons = new Set(["crashed", "launch-failed", "abnormal-exit"]);
  if (
    details.type === "GPU" &&
    failReasons.has(details.reason) &&
    !windowOpened &&
    angleIdx + 1 < ANGLE_BACKENDS.length
  ) {
    clearCache();
    relaunchOn(angleIdx + 1);
  }
});
app.commandLine.appendSwitch("force_high_performance_gpu"); // discrete GPU on dual-GPU machines
app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("enable-zero-copy");
// SharedArrayBuffer: Chromium only grants crossOriginIsolated on http(s)
// origins, so the COOP/COEP headers on app:// are not honoured and libraw-wasm
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

// The app shell's CSP (app-protocol.cjs). connect-src takes the HTTPS and wss:
// origins extensions declare in their manifest's permissions.network: the
// installed ones under userData/plugins and, read the same way, those in the
// Developer Tools dev folder (extension-origins.cjs). The set is computed once
// per launch from the manifests on disk; a newly-installed extension's origins,
// or a newly chosen dev folder's, take effect on the next launch (a natural
// consent point).
// Malformed entries never reach the policy, so a manifest can't inject
// 'unsafe-eval', a data: source, or a bare * into it.
const galleryOrigins = galleryOriginsFrom(process.env);
let launchHosts = [];
// Once per launch, before the first page is served. The dev folder is read
// without blocking: it may sit on a slow or network drive.
async function loadLaunchHosts() {
  launchHosts = declaredConnectHosts([
    ...listPlugins(),
    ...(await listDevManifests(await readDevFolder(devFolderFile()))),
  ]);
}
function extensionConnectHosts() {
  return launchHosts;
}
let cspCache = null;
function appCSP() {
  if (!cspCache) cspCache = buildCSP(galleryOrigins, extensionConnectHosts());
  return cspCache;
}

registerAppScheme(protocol);

// ---------------------------------------------------------------------------
// Extensions: GitHub repos with a safelight.json manifest, installed into
// userData/plugins/<id>/ and loaded by the renderer as ESM. The store backend
// (trust lists, registry index, search, thumbnails, releases, install) lives in
// extension-store/; main.cjs supplies the network, the paths and the writer.
// ---------------------------------------------------------------------------

const userData = () => app.getPath("userData");
// The window material the last session ended on, so a new window's first paint
// already has it. Software rendering has no backdrop to show through.
const materialFile = () => path.join(userData(), "window-material");
const materialSystem = () => ({
  platform: process.platform,
  release: os.release(),
  software: backend === SOFTWARE_BACKEND,
});
const materialOptions = () => windowOptions(readMaterial(materialFile()), materialSystem());
const pluginsDir = () => path.join(userData(), "plugins");
// Work area for in-flight installs/updates (see plugin-files.cjs): beside
// plugins/, never inside it.
const pluginWorkDir = () => path.join(userData(), "plugins-update");
// The Developer Tools dev folder as the renderer last recorded it, so the next
// launch reads its manifests for the CSP the way it reads the installed ones.
const devFolderFile = () => path.join(userData(), "dev-folder.json");

function listPlugins() {
  return listInstalledManifests(pluginsDir());
}

const trust = createTrustList({ net, userData, fileWriter });
const registry = createRegistryIndex({ net, userData, fileWriter });
const thumbnails = createThumbnails({ net, userData, fileWriter });
const releases = createReleases({
  net,
  userData,
  fileWriter,
  registryVersionsFor: registry.registryVersionsFor,
});
const { searchExtensions } = createSearch({
  net,
  userData,
  fileWriter,
  registry,
  cachedThumbnail: thumbnails.cachedThumbnail,
});
const { fetchRepoMeta, fetchReadme } = createRepoInfo({
  net,
  fetchOgImage: thumbnails.fetchOgImage,
});
const { installPlugin, settleUpdate, uninstallPlugin } = createInstaller({
  pluginsDir,
  pluginWorkDir,
  appVersion,
  fetchTrustList: trust.fetchTrustList,
  registryVersionsFor: registry.registryVersionsFor,
  releases,
});
const extensionStore = {
  fetchTrustList: trust.fetchTrustList,
  storeVocabulary: registry.storeVocabulary,
  kits: createKitsIndex({ net, userData }),
  searchExtensions,
  resolveThumbnails: thumbnails.resolveThumbnails,
  fetchRepoMeta,
  fetchReadme,
  fetchReleases: releases.fetchReleases,
  fetchRemoteManifest: releases.fetchRemoteManifest,
  fetchReleasesForStore: releases.fetchReleasesForStore,
  fetchReleaseManifest: releases.fetchReleaseManifest,
  installPlugin,
  settleUpdate,
  uninstallPlugin,
};

// ---------------------------------------------------------------------------
// In-app updater. Downloads Safelight's release asset for this platform,
// checks it against GitHub's published digest and opens it with the system;
// the decisions live in self-update.cjs.
// ---------------------------------------------------------------------------

function updateHost() {
  let osRelease = "";
  if (process.platform === "linux") {
    try {
      osRelease = fs.readFileSync("/etc/os-release", "utf8");
    } catch {}
  }
  return { platform: process.platform, execPath: process.execPath, env: process.env, osRelease };
}

async function installRelease(repo, tag) {
  if (repo !== SAFELIGHT_REPO) throw new Error("Only Safelight's own releases can be installed.");
  const method = selfInstallMethod(updateHost());
  if (!method) throw new Error("This copy of Safelight updates from the release page.");

  const res = await net.fetch(
    `https://api.github.com/repos/${SAFELIGHT_REPO}/releases/tags/${encodeURIComponent(tag)}`,
    {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "Safelight" },
      signal: AbortSignal.timeout(30_000),
    }
  );
  if (!res.ok) throw new Error(`Could not fetch release metadata (${res.status})`);
  const release = await res.json();
  const asset = pickAsset(Array.isArray(release.assets) ? release.assets : [], method);
  if (!asset) throw new Error("No installable asset found for your platform.");
  const expected = sha256Digest(asset.digest);
  if (!expected) throw new Error("This release has no published checksum, so it can't be installed in-app.");

  // Downloads rather than temp: Ubuntu's App Center is a snap with its own
  // private /tmp, so it can't open a package saved there.
  const dir = path.join(app.getPath("downloads"), "Safelight updates");
  await emptyDir(dir);
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, path.basename(asset.name));
  const dlRes = await fetchWithin(
    (url, init) => net.fetch(url, init),
    asset.browser_download_url,
    { headers: { "User-Agent": "Safelight" } },
    30_000
  );
  if (!dlRes.ok || !dlRes.body) throw new Error(`Download failed (${dlRes.status})`);
  await downloadVerified(dlRes.body, file, expected);

  // The shell open is the double-click equivalent, so the installer gets its
  // elevation prompt; a package goes to the user's package manager.
  await launchDownloaded(file, method, {
    openPath: (p) => shell.openPath(p),
    quit: () => app.quit(),
  });
}

// The banner and Preferences can both start an install.
const installReleaseOnce = oneAtATime(installRelease);

// Each webContents' committed main-frame URL, recorded on did-navigate in
// web-contents-created. The privileged guard judges this rather than
// frame.url, which history.pushState moves without loading a document.
const committedUrls = new WeakMap();

// Channels flagged `privileged` in ipc/*.cjs answer only the app's own
// top-level document; see window-policy.cjs.
function handlePrivileged(channel, handler) {
  ipcMain.handle(channel, guardPrivileged(channel, handler, { committedUrls }));
}

function registerIpcChannels() {
  // Nothing is in flight before the first window: a previous version still in
  // the work area belongs to an update that was never settled, so it goes back.
  sweepPluginWork({ pluginsDir: pluginsDir(), workDir: pluginWorkDir() });
  const channels = ipcChannels({
    app,
    BrowserWindow,
    shell,
    dialog,
    appVersion,
    takeOsOpen,
    store: extensionStore,
    listPlugins,
    installReleaseOnce,
    updateHost,
    userData,
    fileWriter,
    crashLog,
    devFolderFile,
    extensionConnectHosts,
    gpuBackendState,
    saveMaterial: (material) => writeMaterial(materialFile(), material),
    isSoftware: () => backend === SOFTWARE_BACKEND,
    setSoftwareRendering,
    setGraphicsBackend,
    rendererFailed,
  });
  registerIpc(channels, { ipcMain, handlePrivileged });
}

// The custom in-app top bars (TopBar, welcome, DevTools — all h-[38px]) double
// as the window title bar via titleBarStyle:'hidden'. On Windows/Linux the
// native min/max/close buttons are drawn as an overlay on the right (keeps
// Windows snap-layout-on-hover); on macOS the traffic lights stay on the left as
// Mac users expect — we only nudge them to vertically centre within the bar.
// The overlay is kept 2px shorter than the bar so the bar's bottom border line
// stays visible beneath the buttons. Overlay colours are recoloured per-surface at
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
  Object.assign(state, fitToWorkArea(state, MIN_WINDOW, workArea));

  // Clearing x/y hands placement back to Electron, which centres on the primary.
  if (positioned && !frameIsReachable(state)) {
    state.x = undefined;
    state.y = undefined;
  }
  return state;
}

function trackWindowState(win) {
  let timer = null;
  // getNormalBounds, not getBounds: maximizing or entering full screen must not
  // overwrite the restored-down geometry that has to come back on the next launch.
  const write = () => {
    const state = {
      ...win.getNormalBounds(),
      maximized: win.isMaximized(),
      fullScreen: win.isFullScreen(),
    };
    try {
      writeAtomicSync(windowStateFile(), JSON.stringify(state));
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
        autoHideMenuBar: true,
        ...titleBarOpts,
        ...materialOptions(),
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
  const minimum = effectiveMinimum(
    MIN_WINDOW,
    (state.x !== undefined && state.y !== undefined
      ? screen.getDisplayMatching(state)
      : screen.getPrimaryDisplay()
    ).workArea,
  );
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: minimum.width,
    minHeight: minimum.height,
    show: false,
    autoHideMenuBar: true,
    ...titleBarOpts,
    ...materialOptions(),
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

  // The minimum follows whichever display the window is on now; a smaller
  // screen (or a resolution change) must not leave the frame bigger than it.
  const refitMinimum = () => {
    if (win.isDestroyed()) return;
    const { workArea } = screen.getDisplayMatching(win.getBounds());
    const min = effectiveMinimum(MIN_WINDOW, workArea);
    win.setMinimumSize(min.width, min.height);
    // A maximized or full-screen window covers the display by design.
    if (win.isMaximized() || win.isFullScreen()) return;
    const { width, height } = win.getBounds();
    if (width > workArea.width || height > workArea.height) {
      win.setSize(Math.min(width, workArea.width), Math.min(height, workArea.height));
    }
  };
  screen.on("display-metrics-changed", refitMinimum);
  screen.on("display-removed", refitMinimum);
  win.on("closed", () => {
    screen.removeListener("display-metrics-changed", refitMinimum);
    screen.removeListener("display-removed", refitMinimum);
  });

  // Restore maximize/full screen here rather than via constructor options:
  // acting on a still-hidden window makes some platforms surface it early,
  // which is the black first frame `show: false` exists to avoid.
  revealWhenReady(win, () => {
    if (state.fullScreen) win.setFullScreen(true);
    else if (state.maximized) win.maximize();
    win.show();
  });

  // One more try covers a load that lost a race at startup; failing twice, the
  // bundle itself won't load and the window would stay hidden for good.
  const loadRetry = createRecoveryGate({ max: 1, minIntervalMs: 0 });
  win.webContents.on("did-fail-load", (_e, errorCode, description, url, isMainFrame) => {
    if (!isMainFrameLoadFailure(errorCode, isMainFrame)) return;
    console.error(`[safelight] ${url} did not load (${errorCode} ${description})`);
    // A failed retry reports through this handler again.
    if (loadRetry.tryRecover() === "ok") win.loadURL("app://bundle/index.html").catch(() => {});
    else offerRestart("load");
  });

  win.loadURL("app://bundle/index.html");
  if (isDev) win.webContents.openDevTools({ mode: "detach" });
  return win;
}

// Once reloading stops helping, a black or blank window is all the user would
// see. One prompt a session: several windows can give up at once.
let restartOffered = false;
function offerRestart(kind) {
  if (restartOffered) return;
  restartOffered = true;
  const gpu = gpuBackendState();
  const softwareNext = gpu.nextSoftware && !gpu.software;
  dialog.showMessageBox(restartPrompt(kind, softwareNext)).then(({ response }) => {
    if (response === RESTART) app.relaunch(relaunchWith());
    app.quit();
  });
}

// The folder (and photo in it) the OS last asked to open, until the renderer
// takes it. The renderer pulls it at boot, so a request that came before it was
// listening is kept; later ones are announced to the windows.
let pendingOsOpen = null;

const landOsOpen = createRequestOrder();

async function queueOsOpen(paths) {
  const lands = landOsOpen();
  const target = await openTargetFor(paths);
  if (!target || !lands()) return;
  pendingOsOpen = target;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("os-open:request");
  }
}

// Hands the waiting target to the renderer once.
function takeOsOpen() {
  const target = pendingOsOpen;
  pendingOsOpen = null;
  return target;
}

// Single instance — focus existing window instead of launching a second copy.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // macOS opens files with the running app through this event, which may fire
  // before ready.
  app.on("open-file", (event, filePath) => {
    event.preventDefault();
    queueOsOpen([filePath]);
  });
  queueOsOpen(argvPaths(process.argv, { defaultApp: process.defaultApp, cwd: process.cwd() }));

  app.on("second-instance", (_e, argv, workingDirectory) => {
    queueOsOpen(argvPaths(argv, { defaultApp: process.defaultApp, cwd: workingDirectory }));
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
      revealWhenReady(childWin, () => childWin.show());
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
  // window. A reload rebuilds everything from the persisted catalogue. Both
  // gates are bounded so a persistently failing GPU ends in a restart prompt
  // instead of a reload storm.
  const gpuRecoveryGate = createRecoveryGate();
  app.on("child-process-gone", (_e, details) => {
    crashLog.record(details.type, details);
    const windows = BrowserWindow.getAllWindows();
    if (!isRuntimeGpuCrash(details, windows.length)) return;
    const recover = gpuRecoveryGate.tryRecover();
    const action = { ok: `reloading ${windows.length} window(s)`, debounced: "too soon after the last reload", spent: "recovery budget spent" };
    console.error(`[safelight] GPU process gone (${details.reason}); ${action[recover]}`);
    if (recover === "ok") for (const win of windows) win.webContents.reload();
    else if (recover === "spent") {
      fallBackToSoftware("gpu-crashes", "GPU crash recovery gave up");
      offerRestart("gpu");
    }
  });

  const rendererRecoveryGate = createRecoveryGate();
  app.on("web-contents-created", (_e, contents) => {
    contents.on("render-process-gone", (_ev, details) => {
      crashLog.record("renderer", details);
      if (!isRendererCrash(details) || contents.isDestroyed()) return;
      const recover = rendererRecoveryGate.tryRecover();
      const action = { ok: "reloading", debounced: "too soon after the last reload", spent: "recovery budget spent" };
      console.error(`[safelight] renderer gone (${details.reason}); ${action[recover]}`);
      if (recover === "ok") contents.reload();
      else if (recover === "spent") offerRestart("renderer");
    });
  });

  // The page sees each key first, so the app's own Cmd+Z / Cmd+A handlers win
  // where they claim the key and the Edit roles serve text fields otherwise.
  const MAC_MENU = [{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }];

  app.whenReady().then(async () => {
    cacheWorkingBackend();
    // macOS takes Cmd+Q and the text-field Edit shortcuts from the menu bar.
    Menu.setApplicationMenu(
      process.platform === "darwin"
        ? Menu.buildFromTemplate(MAC_MENU)
        : null,
    );
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
    await loadLaunchHosts();
    serveAppProtocol({ protocol, net, dist: DIST, pluginsDir, csp: appCSP });
    registerIpcChannels();
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  // Windows send their last catalogue flush as they close, which is after
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
