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
app.commandLine.appendSwitch("use-angle", "d3d11"); // modern ANGLE backend (no D3D9/WARP fallback)
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

function registerPluginIpc() {
  ipcMain.handle("plugins:list", () => listPlugins());
  ipcMain.handle("plugins:install", (_e, spec) => installPlugin(spec));
  ipcMain.handle("plugins:uninstall", (_e, id) => {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(String(id)))
      throw new Error("Bad extension id");
    fs.rmSync(path.join(pluginsDir(), String(id)), {
      recursive: true,
      force: true,
    });
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

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    registerProtocol();
    registerPluginIpc();
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
