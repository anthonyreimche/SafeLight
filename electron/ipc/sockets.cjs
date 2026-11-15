// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The live connections extensions may open once the person allows an address
// (socket-access.cjs). Every channel is privileged: the page's core holds the
// bridge and names the asking extension itself (src/extensions/sockets.ts).

const { createSocketAccess } = require("../socket-access.cjs");
const { listDevManifests, readDevFolder } = require("../extension-origins.cjs");

/**
 * @param {{
 *   BrowserWindow: { fromWebContents(contents: Electron.WebContents): Electron.BrowserWindow | null },
 *   dialog: Pick<Electron.Dialog, "showMessageBox">,
 *   userData: () => string,
 *   fileWriter: { write: (p: string, bytes: Uint8Array) => Promise<void> },
 *   listPlugins: () => Promise<{ id: string, name: string, permissions?: { userSockets?: boolean } }[]>,
 *   devFolderFile: () => string,
 *   extensionConnectHosts: () => string[],
 *   onUninstalled?: (forget: (id: string) => Promise<void>) => void,
 * }} deps
 */
function socketChannels({ BrowserWindow, dialog, userData, fileWriter, listPlugins, devFolderFile, extensionConnectHosts, onUninstalled }) {
  const findManifest = async (id) =>
    (await listPlugins()).find((m) => m.id === id) ??
    (await listDevManifests(await readDevFolder(devFolderFile()))).find((m) => m.id === id) ??
    null;

  const showConsent = async (event, { name, origin }) => {
    const win = event && event.sender ? BrowserWindow.fromWebContents(event.sender) : null;
    const options = {
      type: "question",
      buttons: ["Allow", "Don't allow"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: "Allow a live connection",
      message: `Allow “${name}” to keep a live connection to ${origin}?`,
      detail:
        `“${name}” asked to send and receive data there over a connection that stays open ` +
        `(and over ordinary requests to the same address). ` +
        `It takes effect the next time Safelight starts, and lasts until you disconnect it ` +
        `in the extension's page in the Extensions window.\n\n` +
        `Like every allowed address, other extensions running in Safelight could reach it too.`,
    };
    const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    return response === 0;
  };

  const access = createSocketAccess({
    userData,
    fileWriter,
    findManifest,
    showConsent,
    launchOrigins: extensionConnectHosts,
  });
  if (onUninstalled) onUninstalled((id) => access.forget(id));

  return [
    {
      channel: "sockets:request",
      privileged: true,
      handler: (e, id, url) => access.request(e, String(id), String(url)),
    },
    {
      channel: "sockets:status",
      privileged: true,
      handler: (_e, id, url) => access.status(String(id), String(url)),
    },
    {
      channel: "sockets:list",
      privileged: true,
      handler: (_e, id) => access.list(String(id)),
    },
    {
      channel: "sockets:revoke",
      privileged: true,
      handler: (_e, id, url) => access.revoke(String(id), String(url)),
    },
  ];
}

module.exports = { socketChannels };
