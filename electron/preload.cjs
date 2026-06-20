// Locked-down preload. `safelightNative` is the only bridge: platform info
// plus the extension install/list/uninstall IPC (the renderer-side extension
// API itself lives in the bundle as `window.safelight`).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("safelightNative", {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  },
  appVersion: () => ipcRenderer.invoke("app:version"),
  updates: {
    install: (repo, tag) =>
      ipcRenderer.invoke("updates:install", String(repo), String(tag)),
  },
  releases: {
    fetch: (repo) => ipcRenderer.invoke("releases:fetch", String(repo)),
  },
  // GitHub repo metadata + README for the Extensions store detail view.
  github: {
    repoMeta: (repo) => ipcRenderer.invoke("github:repoMeta", String(repo)),
    readme: (repo, ref) =>
      ipcRenderer.invoke("github:readme", String(repo), String(ref ?? "HEAD")),
  },
  plugins: {
    list: () => ipcRenderer.invoke("plugins:list"),
    install: (spec) => ipcRenderer.invoke("plugins:install", String(spec)),
    search: (query, topic) =>
      ipcRenderer.invoke("plugins:search", String(query ?? ""), String(topic ?? "")),
    uninstall: (id) => ipcRenderer.invoke("plugins:uninstall", String(id)),
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
  // Native file access by absolute path — backs the path-based handle adapters
  // (src/project/native-fs.ts) so the project folder reconnects without an FSA
  // permission gesture.
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
});
