// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The programs extensions may run once the person allows them
// (program-access.cjs). Every channel is privileged: the page's core holds the
// bridge and names the asking extension itself (src/extensions/programs.ts).
// What a program prints comes back as programs:output events to the window
// that asked.

const { createProgramAccess } = require("../program-access.cjs");
const { listDevManifests, readDevFolder } = require("../extension-origins.cjs");

/**
 * @param {{
 *   BrowserWindow: { fromWebContents(contents: Electron.WebContents): Electron.BrowserWindow | null },
 *   dialog: Pick<Electron.Dialog, "showMessageBox" | "showOpenDialog">,
 *   userData: () => string,
 *   fileWriter: { write: (p: string, bytes: Uint8Array) => Promise<void> },
 *   listPlugins: () => Promise<{ id: string, name: string, permissions?: { programs?: boolean } }[]>,
 *   devFolderFile: () => string,
 *   onUninstalled?: (forget: (id: string) => Promise<void>) => void,
 *   onShutdown?: (stop: () => void) => void,
 * }} deps
 */
function programChannels({ BrowserWindow, dialog, userData, fileWriter, listPlugins, devFolderFile, onUninstalled, onShutdown }) {
  const findManifest = async (id) =>
    (await listPlugins()).find((m) => m.id === id) ??
    (await listDevManifests(await readDevFolder(devFolderFile()))).find((m) => m.id === id) ??
    null;

  const windowOf = (event) => (event && event.sender ? BrowserWindow.fromWebContents(event.sender) : null);

  const show = async (event, options) => {
    const win = windowOf(event);
    return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
  };

  const showConsent = async (event, { name, path }) => {
    const { response } = await show(event, {
      type: "question",
      buttons: ["Allow", "Don't allow"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: "Run a program",
      message: `Allow “${name}” to run ${path}?`,
      detail:
        `“${name}” asked to run this program on your computer. A program can read, change and ` +
        `delete your files, like any program you run.\n\n` +
        `Extensions that run other extensions' commands, such as Terminal, can use it through “${name}”. ` +
        `It lasts until you forget it in the extension's page in the Extensions window.`,
    });
    return response === 0;
  };

  const pickPath = async (event, { title, defaultPath, programsOnly }) => {
    const win = windowOf(event);
    const options = {
      properties: ["openFile"],
      ...(title ? { title } : {}),
      ...(defaultPath ? { defaultPath } : {}),
      ...(programsOnly ? { filters: [{ name: "Programs", extensions: ["exe", "com"] }] } : {}),
    };
    const { canceled, filePaths } = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return canceled || !filePaths[0] ? null : filePaths[0];
  };

  const access = createProgramAccess({ userData, fileWriter, findManifest, showConsent, pickPath });
  if (onUninstalled) onUninstalled((id) => access.forgetExtension(id));
  if (onShutdown) onShutdown(() => access.killAll());

  return [
    {
      channel: "programs:pick",
      privileged: true,
      handler: (e, id, options) => access.pick(e, String(id), options && typeof options === "object" ? options : {}),
    },
    {
      channel: "programs:locate",
      privileged: true,
      handler: (e, id, name) => access.locate(e, String(id), String(name)),
    },
    {
      channel: "programs:list",
      privileged: true,
      handler: (_e, id) => access.list(String(id)),
    },
    {
      channel: "programs:forget",
      privileged: true,
      handler: (_e, id, token) => access.forget(String(id), String(token)),
    },
    {
      channel: "programs:run",
      privileged: true,
      handler: (e, id, runId, token, args, options) => access.run(e, String(id), String(runId), String(token), args, options),
    },
    {
      channel: "programs:cancel",
      privileged: true,
      handler: (e, runId) => access.cancel(e, String(runId)),
    },
  ];
}

module.exports = { programChannels };
