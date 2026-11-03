// Locked-down preload. `safelightNative` is the only bridge: platform info
// plus the extension install/list/uninstall IPC (the renderer-side extension
// API itself lives in the bundle as `window.safelight`).
const { contextBridge, ipcRenderer } = require("electron");

// Privileged surface — raw filesystem by absolute path, running an update
// installer (which fetches + executes a release asset), installing and removing
// extensions (which puts code on disk that later runs), capturing the
// window for Report an issue, switching how the next launch draws (software
// rendering), and opening the folder the OS asked for. Extension code shares
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
    rendererFailed: (detail) => ipcRenderer.invoke("gpu:rendererFailed", String(detail)),
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
    // Records the dev folder so the next launch reads its manifests' declared
    // network origins like an installed extension's; resolves with the origins
    // this launch's policy does not allow yet.
    syncDevFolder: (folder) =>
      ipcRenderer.invoke("devtools:sync-dev-folder", folder == null ? null : String(folder)),
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
