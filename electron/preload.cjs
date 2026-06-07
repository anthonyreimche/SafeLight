// Minimal, locked-down preload. The renderer is a self-contained Vite bundle
// and needs no Node APIs, so we expose only a tiny version marker via the
// context bridge. Extend here if the app later needs native file dialogs etc.
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("safelight", {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  },
});
