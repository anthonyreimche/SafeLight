// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Developer Tools extension bridge. Lets the (opt-in, disabled-by-default)
// Developer Tools panel drive the window's Chrome DevTools and read main-process
// diagnostics. Gated by the renderer: the panel only exists when the user
// enables the extension. Report an issue reads the same diagnostics, plus the
// crash log, a window capture and the issue-link opener.

const {
  declaredConnectHosts,
  listDevManifests,
  pendingConnectHosts,
  writeDevFolder,
} = require("../extension-origins.cjs");
const { openIssueLink } = require("../issue-link.cjs");

const DEVTOOLS_MODES = new Set(["right", "bottom", "undocked", "detach"]);

/**
 * @param {{
 *   app: Pick<Electron.App, "getGPUFeatureStatus" | "getAppMetrics">,
 *   BrowserWindow: { fromWebContents(contents: Electron.WebContents): Electron.BrowserWindow | null },
 *   shell: Pick<Electron.Shell, "openExternal">,
 *   crashLog: { list(): unknown[] },
 *   devFolderFile: () => string,
 *   extensionConnectHosts: () => string[],
 *   gpuBackendState: () => unknown,
 *   setSoftwareRendering: (on: boolean) => unknown,
 *   rendererFailed: (detail: string) => unknown,
 * }} deps
 */
function diagnosticsChannels({
  app,
  BrowserWindow,
  shell,
  crashLog,
  devFolderFile,
  extensionConnectHosts,
  gpuBackendState,
  setSoftwareRendering,
  rendererFailed,
}) {
  const senderWindow = (e) => BrowserWindow.fromWebContents(e.sender);

  return [
    {
      channel: "devtools:open",
      privileged: false,
      handler: (e, mode) => {
        const wc = senderWindow(e)?.webContents;
        if (wc) wc.openDevTools({ mode: DEVTOOLS_MODES.has(mode) ? mode : "detach" });
      },
    },
    {
      channel: "devtools:close",
      privileged: false,
      handler: (e) => senderWindow(e)?.webContents.closeDevTools(),
    },
    {
      channel: "devtools:toggle",
      privileged: false,
      handler: (e) => {
        const wc = senderWindow(e)?.webContents;
        if (!wc) return;
        if (wc.isDevToolsOpened()) wc.closeDevTools();
        else wc.openDevTools({ mode: "detach" });
      },
    },
    {
      channel: "devtools:isOpen",
      privileged: false,
      handler: (e) => !!senderWindow(e)?.webContents.isDevToolsOpened(),
    },
    {
      channel: "devtools:reload",
      privileged: false,
      handler: (e, hard) => {
        const wc = senderWindow(e)?.webContents;
        if (!wc) return;
        if (hard) wc.reloadIgnoringCache();
        else wc.reload();
      },
    },
    // Records the dev folder, so the next launch reads its manifests' declared
    // network origins the way it reads installed extensions' (see
    // extensionConnectHosts), and answers with the origins that folder declares
    // which this launch's policy does not allow yet.
    {
      channel: "devtools:sync-dev-folder",
      privileged: false,
      handler: (_e, folder) => {
        const f = typeof folder === "string" && folder.trim() ? folder : null;
        writeDevFolder(devFolderFile(), f);
        return {
          pending: pendingConnectHosts(
            declaredConnectHosts(listDevManifests(f)),
            extensionConnectHosts()
          ),
        };
      },
    },
    {
      channel: "diagnostics:gpuInfo",
      privileged: false,
      handler: () => app.getGPUFeatureStatus(),
    },
    // Preferences ▸ Rendering ▸ Software rendering.
    // Privileged: it sets how every later launch draws.
    {
      channel: "gpu:backend",
      privileged: true,
      handler: () => gpuBackendState(),
    },
    {
      channel: "gpu:setSoftware",
      privileged: true,
      handler: (_e, on) => setSoftwareRendering(on === true),
    },
    {
      channel: "gpu:rendererFailed",
      privileged: true,
      handler: (_e, detail) => rendererFailed(String(detail).slice(0, 500)),
    },
    {
      channel: "diagnostics:metrics",
      privileged: false,
      handler: () =>
        app.getAppMetrics().map((m) => ({
          type: m.type,
          pid: m.pid,
          cpuPercent: m.cpu ? m.cpu.percentCPUUsage : 0,
          // workingSetSize is reported in kilobytes.
          memoryMB: m.memory ? m.memory.workingSetSize / 1024 : 0,
        })),
    },
    {
      channel: "diagnostics:crashes",
      privileged: false,
      handler: () => crashLog.list(),
    },
    {
      channel: "report:openIssue",
      privileged: false,
      handler: (_e, url) => openIssueLink(url, { openExternal: (u) => shell.openExternal(u) }),
    },
    // Privileged: a public capture would let any extension take silent
    // screenshots of the whole window.
    {
      channel: "diagnostics:capturePage",
      privileged: true,
      handler: async (e) => {
        let image = await e.sender.capturePage();
        if (image.isEmpty()) return null;
        const { width, height } = image.getSize();
        if (Math.max(width, height) > 1920) {
          image = image.resize(width >= height ? { width: 1920 } : { height: 1920 });
        }
        return image.toPNG();
      },
    },
  ];
}

module.exports = { diagnosticsChannels };
