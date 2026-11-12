// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Every IPC channel the main process answers, as one table of
// { channel, privileged, handler }. A privileged channel answers only the app's
// own top-level document (window-policy.cjs guardPrivileged); the rest answer
// any document, extensions' pages included. Building the table calls none of
// its dependencies, so the tests read the split from it directly.

const { diagnosticsChannels } = require("./diagnostics.cjs");
const { extensionChannels } = require("./extensions.cjs");
const { fsChannels } = require("./fs.cjs");
const { netChannels } = require("./net.cjs");
const { windowChannels } = require("./window.cjs");

/**
 * @typedef {{
 *   channel: string,
 *   privileged: boolean,
 *   handler: (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown,
 * }} IpcChannel
 */

/**
 * @param {Parameters<typeof windowChannels>[0]
 *   & Parameters<typeof extensionChannels>[0]
 *   & Parameters<typeof fsChannels>[0]
 *   & Parameters<typeof diagnosticsChannels>[0]
 *   & Parameters<typeof netChannels>[0]} deps
 * @returns {IpcChannel[]}
 */
function ipcChannels(deps) {
  // What a channel group keeps per extension (kept folders, allowed server
  // addresses) is forgotten when the extension is uninstalled; an update keeps it.
  const forgetters = [];
  const shared = {
    ...deps,
    onUninstalled: (forget) => void forgetters.push(forget),
    forgetUninstalled: async (id) => {
      for (const forget of forgetters) {
        try {
          await forget(id);
        } catch (e) {
          console.warn(`[extensions] couldn't forget what ${id} was given:`, e);
        }
      }
    },
  };
  return [
    ...windowChannels(shared),
    ...extensionChannels(shared),
    ...fsChannels(shared),
    ...diagnosticsChannels(shared),
    ...netChannels(shared),
  ];
}

/**
 * @param {IpcChannel[]} channels
 * @param {{
 *   ipcMain: Pick<Electron.IpcMain, "handle">,
 *   handlePrivileged: (channel: string, handler: IpcChannel["handler"]) => void,
 * }} registrars
 */
function registerIpc(channels, { ipcMain, handlePrivileged }) {
  for (const { channel, privileged, handler } of channels) {
    if (privileged) handlePrivileged(channel, handler);
    else ipcMain.handle(channel, handler);
  }
}

module.exports = { ipcChannels, registerIpc };
