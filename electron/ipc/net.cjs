// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The server addresses extensions may reach once the person allows them
// (net-access.cjs). Every channel is privileged: the page's core holds the
// bridge and names the asking extension itself (src/extensions/network.ts).

const { createNetAccess } = require("../net-access.cjs");
const { listDevManifests, readDevFolder } = require("../extension-origins.cjs");

/**
 * @param {{
 *   BrowserWindow: { fromWebContents(contents: Electron.WebContents): Electron.BrowserWindow | null },
 *   dialog: Pick<Electron.Dialog, "showMessageBox">,
 *   userData: () => string,
 *   fileWriter: { write: (p: string, bytes: Uint8Array) => Promise<void> },
 *   listPlugins: () => Promise<{ id: string, name: string, permissions?: { userOrigins?: boolean } }[]>,
 *   devFolderFile: () => string,
 *   fetchImpl?: typeof fetch,
 *   onUninstalled?: (forget: (id: string) => Promise<void>) => void,
 * }} deps
 */
function netChannels({ BrowserWindow, dialog, userData, fileWriter, listPlugins, devFolderFile, fetchImpl, onUninstalled }) {
  const findManifest = async (id) =>
    (await listPlugins()).find((m) => m.id === id) ??
    (await listDevManifests(await readDevFolder(devFolderFile()))).find((m) => m.id === id) ??
    null;

  const showConsent = async (event, { name, origin, plain }) => {
    const win = event && event.sender ? BrowserWindow.fromWebContents(event.sender) : null;
    const detail =
      `“${name}” asked to connect to this address. It can send and receive data there ` +
      `until you disconnect it in its settings.` +
      (plain
        ? `\n\nThis address uses plain HTTP: anyone on the same network can read what ` +
          `is sent, keys and photos included. Use it only on a network you trust.`
        : "");
    const options = {
      type: "question",
      buttons: ["Allow", "Don't allow"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: "Connect to a server",
      message: `Allow “${name}” to connect to ${origin}?`,
      detail,
    };
    const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    return response === 0;
  };

  const access = createNetAccess({ userData, fileWriter, findManifest, showConsent, fetchImpl });
  if (onUninstalled) onUninstalled((id) => access.forget(id));

  return [
    {
      channel: "net:requestOrigin",
      privileged: true,
      handler: (e, id, url) => access.request(e, String(id), String(url)),
    },
    {
      channel: "net:hasOrigin",
      privileged: true,
      handler: (_e, id, url) => access.has(String(id), String(url)),
    },
    {
      channel: "net:revokeOrigin",
      privileged: true,
      handler: (_e, id, url) => access.revoke(String(id), String(url)),
    },
    {
      channel: "net:fetch",
      privileged: true,
      handler: (_e, id, requestId, url, init) =>
        access.fetch(String(id), requestId == null ? null : String(requestId), String(url), init ?? {}),
    },
    {
      channel: "net:abort",
      privileged: true,
      handler: (_e, requestId) => access.abort(String(requestId)),
    },
  ];
}

module.exports = { netChannels };
