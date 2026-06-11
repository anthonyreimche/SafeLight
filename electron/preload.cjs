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
  plugins: {
    list: () => ipcRenderer.invoke("plugins:list"),
    install: (spec) => ipcRenderer.invoke("plugins:install", String(spec)),
    search: (query, topic) =>
      ipcRenderer.invoke("plugins:search", String(query ?? ""), String(topic ?? "")),
    uninstall: (id) => ipcRenderer.invoke("plugins:uninstall", String(id)),
  },
});
