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

const isDev = !app.isPackaged;
const DIST = path.join(__dirname, "..", "dist");

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
  "Cross-Origin-Embedder-Policy": "require-corp",
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
  "img-src 'self' data: blob:",
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

async function installPlugin(spec) {
  const { owner, repo, ref } = parseRepoSpec(spec);
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
async function searchExtensions(query, topic) {
  const t = String(topic || "safelight-extension").trim();
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(t)) throw new Error("Bad extension topic");
  const q = [String(query || "").trim(), `topic:${t}`]
    .filter(Boolean)
    .join(" ");
  const res = await net.fetch(
    `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=25`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Safelight",
      },
    }
  );
  if (res.status === 403 || res.status === 429)
    throw new Error("GitHub rate limit reached — try again in a minute.");
  if (!res.ok) throw new Error(`GitHub search failed (${res.status})`);
  const body = await res.json();
  return (body.items || []).map((r) => ({
    fullName: r.full_name,
    description: r.description,
    stars: r.stargazers_count || 0,
    updatedAt: r.updated_at,
  }));
}

function registerPluginIpc() {
  ipcMain.handle("plugins:list", () => listPlugins());
  ipcMain.handle("plugins:install", (_e, spec) => installPlugin(spec));
  ipcMain.handle("plugins:search", (_e, query, topic) =>
    searchExtensions(query, topic)
  );
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
    await fs.promises.writeFile(p, Buffer.from(data));
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

function createWindow() {
  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#1a1a1a",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: isDev,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  win.once("ready-to-show", () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    // Internal windows = detachable modules (window.open to an app:// URL).
    // Allow them as native child windows with the same isolation settings so
    // the custom-protocol origin, preload, and COOP/COEP all carry over and
    // BroadcastChannel sync keeps working.
    if (url.startsWith("app://")) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          backgroundColor: "#1a1a1a",
          autoHideMenuBar: true,
          webPreferences: {
            preload: path.join(__dirname, "preload.cjs"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            devTools: isDev,
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
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
