// Locked-down preload. `safelightNative` is the only bridge: platform info
// plus the extension install/list/uninstall IPC (the renderer-side extension
// API itself lives in the bundle as `window.safelight`).
const { contextBridge, ipcRenderer } = require("electron");

// Privileged surface — raw filesystem by absolute path, running an update
// installer (which fetches + executes a release asset), installing and removing
// extensions (which puts code on disk that later runs), capturing the
// window for Report an issue, switching how the next launch draws (software
// rendering), opening the folder the OS asked for, and recording the Developer
// Tools dev folder (which widens the next launch's network policy). Extension code shares
// the renderer realm, so anything left on window.safelightNative is reachable by
// a malicious extension. These are handed out exactly once, at renderer boot, to
// core code that captures them privately (src/native/privileged.ts); every later
// claim returns null, so an extension (which loads after boot) can never reach
// them. The gating lives here in the preload closure because contextBridge
// freezes the exposed object — the renderer can't re-add or delete properties.
let privilegedClaimed = false;
const privileged = {
  updates: {
    install: (repo, tag) =>
      ipcRenderer.invoke("updates:install", String(repo), String(tag)),
    // What this copy can offer for a release with these assets.
    support: (assetNames) =>
      ipcRenderer.invoke(
        "updates:support",
        Array.isArray(assetNames) ? assetNames.map(String) : [],
      ),
  },
  fs: {
    read: (p, range) =>
      ipcRenderer.invoke(
        "fs:read",
        String(p),
        range ? { start: Number(range.start), end: Number(range.end) } : undefined,
      ),
    write: (p, data) => ipcRenderer.invoke("fs:write", String(p), data),
    list: (p, root, withSizes) =>
      ipcRenderer.invoke("fs:list", String(p), root ? String(root) : undefined, withSizes === true),
    mkdir: (p) => ipcRenderer.invoke("fs:mkdir", String(p)),
    externalCatalogDir: (p, base, create, variant) =>
      ipcRenderer.invoke(
        "fs:externalCatalogDir",
        String(p),
        base ? String(base) : null,
        create !== false,
        Number(variant) || 1,
      ),
    externalCatalogVariants: (p, base) =>
      ipcRenderer.invoke("fs:externalCatalogVariants", String(p), base ? String(base) : null),
    sourceCatalogDir: (key, name) =>
      ipcRenderer.invoke("fs:sourceCatalogDir", String(key), String(name)),
    listExternalCatalogs: (base) =>
      ipcRenderer.invoke("fs:listExternalCatalogs", base ? String(base) : null),
    setSpilloverPointer: (rp, dir) =>
      ipcRenderer.invoke("fs:setSpilloverPointer", String(rp), String(dir)),
    getSpilloverPointer: (rp) =>
      ipcRenderer.invoke("fs:getSpilloverPointer", String(rp)),
    clearSpilloverPointer: (rp) =>
      ipcRenderer.invoke("fs:clearSpilloverPointer", String(rp)),
    remove: (p) => ipcRenderer.invoke("fs:remove", String(p)),
    trash: (p) => ipcRenderer.invoke("fs:trash", String(p)),
    move: (src, dest) => ipcRenderer.invoke("fs:move", String(src), String(dest)),
    exists: (p) => ipcRenderer.invoke("fs:exists", String(p)),
    pickDirectory: () => ipcRenderer.invoke("fs:pickDirectory"),
    pickKeptFolder: (id, replacing) =>
      ipcRenderer.invoke("fs:pickKeptFolder", String(id), replacing == null ? null : String(replacing)),
    keptFolder: (id, token) => ipcRenderer.invoke("fs:keptFolder", String(id), String(token)),
    forgetKeptFolder: (id, token) => ipcRenderer.invoke("fs:forgetKeptFolder", String(id), String(token)),
    pickFile: (filters) =>
      ipcRenderer.invoke("fs:pickFile", Array.isArray(filters) ? filters : []),
    reveal: (p) => ipcRenderer.invoke("fs:reveal", String(p)),
  },
  // Putting extension code on disk and taking it off again.
  plugins: {
    install: (spec, version) =>
      version == null
        ? ipcRenderer.invoke("plugins:install", String(spec))
        : ipcRenderer.invoke("plugins:install", String(spec), String(version)),
    uninstall: (id) => ipcRenderer.invoke("plugins:uninstall", String(id)),
    // Finish an install/update: "keep" drops the previous copy, "rollback"
    // restores it (and returns its manifest).
    settleUpdate: (id, outcome) =>
      ipcRenderer.invoke("plugins:settle-update", String(id), String(outcome)),
  },
  capture: {
    page: () => ipcRenderer.invoke("diagnostics:capturePage"),
  },
  // Software rendering for the next launch.
  gpu: {
    backend: () => ipcRenderer.invoke("gpu:backend"),
    setSoftware: (on) => ipcRenderer.invoke("gpu:setSoftware", !!on),
    setBackend: (choice) => ipcRenderer.invoke("gpu:setBackend", typeof choice === "string" ? choice : null),
    rendererFailed: (detail) => ipcRenderer.invoke("gpu:rendererFailed", String(detail)),
  },
  // The window's material (acrylic, mica): a theme asks for it, the system
  // draws it. Privileged so an extension can't change how the window paints.
  window: {
    setMaterial: (material) =>
      ipcRenderer.invoke("window:setMaterial", typeof material === "string" ? material : null),
    // The app's pop-outs, opened by the main process: a page that opens a
    // window holds its object and could claim this bridge there first.
    openApp: (kind, module) =>
      ipcRenderer.invoke("window:openApp", String(kind), module == null ? null : String(module)),
    closeApp: (kind, module) =>
      ipcRenderer.invoke("window:closeApp", String(kind), module == null ? null : String(module)),
    focusMain: () => ipcRenderer.invoke("window:focusMain"),
  },
  // Records the dev folder so the next launch reads its manifests' declared
  // network origins like an installed extension's; resolves with the origins
  // this launch's policy does not allow yet.
  devtools: {
    syncDevFolder: (folder) =>
      ipcRenderer.invoke("devtools:sync-dev-folder", folder == null ? null : String(folder)),
  },
  // Server addresses the person allowed an extension to reach (net-access.cjs).
  // Privileged so core names the asking extension, not the page.
  net: {
    requestOrigin: (id, url) => ipcRenderer.invoke("net:requestOrigin", String(id), String(url)),
    hasOrigin: (id, url) => ipcRenderer.invoke("net:hasOrigin", String(id), String(url)),
    revokeOrigin: (id, url) => ipcRenderer.invoke("net:revokeOrigin", String(id), String(url)),
    fetch: (id, requestId, url, init) =>
      ipcRenderer.invoke("net:fetch", String(id), String(requestId), String(url), {
        method: init && typeof init.method === "string" ? init.method : undefined,
        headers: init && init.headers && typeof init.headers === "object" ? { ...init.headers } : undefined,
        body: init && (typeof init.body === "string" || init.body instanceof Uint8Array) ? init.body : undefined,
        timeoutMs: init && Number.isFinite(init.timeoutMs) ? Number(init.timeoutMs) : undefined,
      }),
    abort: (requestId) => ipcRenderer.invoke("net:abort", String(requestId)),
    // Signing in to a web service: a one-time listener on 127.0.0.1 for the
    // browser's redirect (oauth-loopback.cjs).
    authorizeListen: (id, timeoutMs) =>
      ipcRenderer.invoke("net:authorizeListen", String(id), Number.isFinite(timeoutMs) ? Number(timeoutMs) : undefined),
    authorizeOpen: (id, session, url) =>
      ipcRenderer.invoke("net:authorizeOpen", String(id), String(session), String(url)),
    authorizeCancel: (id, session) => ipcRenderer.invoke("net:authorizeCancel", String(id), String(session)),
  },
  // Values an extension keeps encrypted by the OS keychain
  // (extension-secrets.cjs). Privileged so core names the asking extension.
  secrets: {
    available: () => ipcRenderer.invoke("secrets:available"),
    get: (id, key) => ipcRenderer.invoke("secrets:get", String(id), String(key)),
    set: (id, key, value) => ipcRenderer.invoke("secrets:set", String(id), String(key), String(value)),
    delete: (id, key) => ipcRenderer.invoke("secrets:delete", String(id), String(key)),
  },
  // Live connections the person allowed an extension to open (socket-access.cjs).
  // Privileged so core names the asking extension, not the page.
  sockets: {
    request: (id, url) => ipcRenderer.invoke("sockets:request", String(id), String(url)),
    status: (id, url) => ipcRenderer.invoke("sockets:status", String(id), String(url)),
    list: (id) => ipcRenderer.invoke("sockets:list", String(id)),
    revoke: (id, url) => ipcRenderer.invoke("sockets:revoke", String(id), String(url)),
  },
  // A photo or folder the OS asked Safelight to open. Privileged: the target
  // is opened as the project, a folder on disk the page chose nothing about.
  osOpen: {
    take: () => ipcRenderer.invoke("os-open:take"),
    onRequest: (cb) => {
      const handler = () => cb();
      ipcRenderer.on("os-open:request", handler);
      return () => ipcRenderer.removeListener("os-open:request", handler);
    },
  },
};

contextBridge.exposeInMainWorld("safelightNative", {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  },
  system: {
    arch: process.arch,
    osVersion: process.getSystemVersion(),
  },
  appVersion: () => ipcRenderer.invoke("app:version"),
  // One-shot handover of the privileged fs + update-installer surface (above).
  claimPrivileged: () => {
    if (privilegedClaimed) return null;
    privilegedClaimed = true;
    return privileged;
  },
  releases: {
    fetch: (repo) => ipcRenderer.invoke("releases:fetch", String(repo)),
  },
  // GitHub repo metadata + README for the Extensions store detail view.
  github: {
    repoMeta: (repo) => ipcRenderer.invoke("github:repoMeta", String(repo)),
    readme: (repo, ref) =>
      ipcRenderer.invoke("github:readme", String(repo), String(ref ?? "HEAD")),
    thumbnails: (items, force) =>
      ipcRenderer.invoke(
        "github:thumbnails",
        Array.isArray(items) ? items : [],
        !!force,
      ),
    // Per-repo thumbnails pushed by the main process as each resolves, so the
    // grid upgrades cards progressively. Returns an unsubscribe fn.
    onThumbnail: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on("github:thumbnail", handler);
      return () => ipcRenderer.removeListener("github:thumbnail", handler);
    },
  },
  plugins: {
    list: () => ipcRenderer.invoke("plugins:list"),
    search: (query, topic, force) =>
      ipcRenderer.invoke(
        "plugins:search",
        String(query ?? ""),
        String(topic ?? ""),
        !!force,
      ),
    remoteManifest: (repo, opts) =>
      ipcRenderer.invoke("plugins:remote-manifest", String(repo), {
        prerelease: !!(opts && opts.prerelease),
      }),
    // A repo's GitHub releases, for the store's version picker and notes.
    releases: (repo, force) =>
      ipcRenderer.invoke("plugins:releases", String(repo), !!force),
    // safelight.json at one release's tag (its version and minAppVersion).
    manifestAt: (repo, version) =>
      ipcRenderer.invoke("plugins:manifest-at", String(repo), String(version)),
    // Verified-allowlist + banned-kill-switch lists from the trust registry.
    trustList: (force) => ipcRenderer.invoke("plugins:trust-list", !!force),
    // The welcome setup's starter kits (kits.json in the trust registry).
    kits: (force) => ipcRenderer.invoke("plugins:kits", !!force),
    // The store's category vocabulary from the registry index, or null.
    vocabulary: () => ipcRenderer.invoke("plugins:store-vocabulary"),
  },
  // Chrome DevTools control + main-process diagnostics for the opt-in
  // Developer Tools extension (src/extensions/devtools/).
  devtools: {
    open: (mode) => ipcRenderer.invoke("devtools:open", String(mode ?? "detach")),
    close: () => ipcRenderer.invoke("devtools:close"),
    toggle: () => ipcRenderer.invoke("devtools:toggle"),
    isOpen: () => ipcRenderer.invoke("devtools:isOpen"),
    reload: (hard) => ipcRenderer.invoke("devtools:reload", !!hard),
  },
  diagnostics: {
    gpuInfo: () => ipcRenderer.invoke("diagnostics:gpuInfo"),
    metrics: () => ipcRenderer.invoke("diagnostics:metrics"),
    crashes: () => ipcRenderer.invoke("diagnostics:crashes"),
  },
  report: {
    openIssue: (url) => ipcRenderer.invoke("report:openIssue", String(url)),
  },
  // Recolor the native window-controls overlay (Windows/Linux) to match the
  // active theme; no-op on macOS.
  titlebar: {
    setOverlay: (color, symbolColor, uiScale) =>
      ipcRenderer.invoke(
        "window:setTitleBarOverlay",
        String(color),
        String(symbolColor),
        Number(uiScale),
      ),
  },
});
