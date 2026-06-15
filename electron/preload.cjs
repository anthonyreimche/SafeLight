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
  plugins: {
    list: () => ipcRenderer.invoke("plugins:list"),
    install: (spec) => ipcRenderer.invoke("plugins:install", String(spec)),
    search: (query, topic) =>
      ipcRenderer.invoke("plugins:search", String(query ?? ""), String(topic ?? "")),
    uninstall: (id) => ipcRenderer.invoke("plugins:uninstall", String(id)),
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
