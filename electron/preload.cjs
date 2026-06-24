// Locked-down preload. `safelightNative` is the only bridge: platform info
// plus the extension install/list/uninstall IPC (the renderer-side extension
// API itself lives in the bundle as `window.safelight`).
const { contextBridge, ipcRenderer } = require("electron");

// Privileged surface — raw filesystem by absolute path, and running an update
// installer (which fetches + executes a release asset). Extension code shares
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
  },
  fs: {
    read: (p) => ipcRenderer.invoke("fs:read", String(p)),
    write: (p, data) => ipcRenderer.invoke("fs:write", String(p), data),
    list: (p) => ipcRenderer.invoke("fs:list", String(p)),
    mkdir: (p) => ipcRenderer.invoke("fs:mkdir", String(p)),
    remove: (p) => ipcRenderer.invoke("fs:remove", String(p)),
    move: (src, dest) => ipcRenderer.invoke("fs:move", String(src), String(dest)),
    exists: (p) => ipcRenderer.invoke("fs:exists", String(p)),
    pickDirectory: () => ipcRenderer.invoke("fs:pickDirectory"),
  },
};

contextBridge.exposeInMainWorld("safelightNative", {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
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
    iconUrl: (repo) => ipcRenderer.invoke("github:iconUrl", String(repo)),
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
    install: (spec) => ipcRenderer.invoke("plugins:install", String(spec)),
    search: (query, topic, force) =>
      ipcRenderer.invoke(
        "plugins:search",
        String(query ?? ""),
        String(topic ?? ""),
        !!force,
      ),
    uninstall: (id) => ipcRenderer.invoke("plugins:uninstall", String(id)),
    latestVersion: (repo) =>
      ipcRenderer.invoke("plugins:latest-version", String(repo)),
    // Verified-allowlist + banned-kill-switch lists from the trust registry.
    trustList: (force) => ipcRenderer.invoke("plugins:trust-list", !!force),
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
  },
  // Recolor the native window-controls overlay (Windows/Linux) to match the
  // active theme; no-op on macOS.
  titlebar: {
    setOverlay: (color, symbolColor) =>
      ipcRenderer.invoke("window:setTitleBarOverlay", String(color), String(symbolColor)),
  },
});
