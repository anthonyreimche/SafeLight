// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Native file bridge. Lets the renderer read/write the open project folder by
// absolute path instead of through File System Access handles. Paths don't
// expire across sessions the way FSA permissions do, so the originals reconnect
// on launch with no user gesture (Lightroom-style). Trust scope: windows only
// ever hold the app's own index (window-policy.cjs), and every fs:* call is
// refused unless it comes from such a document's top frame, so every channel
// here is privileged. The file operations themselves live in fs-bridge.cjs, which
// `slu` shares; this file adds the channels and the ones that need Electron.

const fs = require("node:fs");
const path = require("node:path");
const { createFsBridge, notRoot } = require("../fs-bridge.cjs");
const { createKeptFolders } = require("../kept-folders.cjs");
const { createCardScanner } = require("../memory-cards.cjs");

/**
 * @param {{
 *   userData: () => string,
 *   fileWriter: { write(file: string, data: Uint8Array): Promise<void> },
 *   shell: Pick<Electron.Shell, "trashItem" | "openPath" | "showItemInFolder">,
 *   dialog: Pick<Electron.Dialog, "showOpenDialog">,
 *   BrowserWindow: { fromWebContents(contents: Electron.WebContents): Electron.BrowserWindow | null },
 *   onUninstalled?: (forget: (id: string) => Promise<void>) => void,
 * }} deps
 */
function fsChannels({ userData, fileWriter, shell, dialog, BrowserWindow, onUninstalled }) {
  const kept = createKeptFolders({
    userData,
    fileWriter,
    pickPath: async (e, defaultPath) => {
      const win = BrowserWindow.fromWebContents(e.sender);
      const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        properties: ["openDirectory"],
        ...(defaultPath ? { defaultPath } : {}),
      });
      return canceled || !filePaths[0] ? null : filePaths[0];
    },
  });
  if (onUninstalled) onUninstalled((id) => kept.forgetExtension(id));
  const bridge = createFsBridge({ userData, writer: fileWriter });
  const cards = createCardScanner();
  // A channel for each bridge method: the event comes first and is dropped.
  const forward = (channel, method) => ({
    channel,
    privileged: true,
    handler: (_e, ...args) => bridge[method](...args),
  });
  return [
    forward("fs:read", "read"),
    forward("fs:write", "write"),
    forward("fs:list", "list"),
    forward("fs:mkdir", "mkdir"),
    forward("fs:externalCatalogDir", "externalCatalogDir"),
    forward("fs:externalCatalogVariants", "externalCatalogVariants"),
    forward("fs:sourceCatalogDir", "sourceCatalogDir"),
    forward("fs:listExternalCatalogs", "listExternalCatalogs"),
    forward("fs:setSpilloverPointer", "setSpilloverPointer"),
    forward("fs:getSpilloverPointer", "getSpilloverPointer"),
    forward("fs:clearSpilloverPointer", "clearSpilloverPointer"),
    forward("fs:remove", "remove"),
    // Recoverable delete: the OS trash (Recycle Bin) instead of rm. Rejects when
    // the platform can't trash the path (e.g. some network mounts) — the renderer
    // reports that per file rather than falling back to a hard delete.
    {
      channel: "fs:trash",
      privileged: true,
      handler: async (_e, p) => {
        await shell.trashItem(path.normalize(notRoot(p)));
      },
    },
    forward("fs:move", "move"),
    forward("fs:exists", "exists"),
    forward("fs:lockProject", "lockProject"),
    forward("fs:refreshProjectLock", "refreshProjectLock"),
    forward("fs:releaseProjectLock", "releaseProjectLock"),
    // Memory cards in the computer now, for an ingest (api.library.useMemoryCards).
    { channel: "fs:listCards", privileged: true, handler: () => cards.list() },
    {
      channel: "fs:pickDirectory",
      privileged: true,
      handler: async (e) => {
        const win = BrowserWindow.fromWebContents(e.sender);
        const { canceled, filePaths } = await dialog.showOpenDialog(win, {
          properties: ["openDirectory"],
        });
        return canceled || !filePaths[0] ? null : filePaths[0];
      },
    },
    // Folders an extension keeps across launches (kept-folders.cjs). Core names
    // the asking extension; the page only ever holds a token.
    {
      channel: "fs:pickKeptFolder",
      privileged: true,
      handler: (e, id, replacing) => kept.pick(e, String(id), replacing == null ? null : String(replacing)),
    },
    {
      channel: "fs:keptFolder",
      privileged: true,
      handler: (_e, id, token) => kept.open(String(id), String(token)),
    },
    {
      channel: "fs:forgetKeptFolder",
      privileged: true,
      handler: (_e, id, token) => kept.forget(String(id), String(token)),
    },
    // One file, e.g. the monitor's ICC profile in Preferences. Filters come from
    // the renderer, so only well-formed ones reach the dialogue.
    {
      channel: "fs:pickFile",
      privileged: true,
      handler: async (e, filters) => {
        const win = BrowserWindow.fromWebContents(e.sender);
        const wellFormed = (Array.isArray(filters) ? filters : [])
          .filter((f) => f && typeof f.name === "string" && Array.isArray(f.extensions))
          .map((f) => ({
            name: f.name,
            extensions: f.extensions.filter((x) => typeof x === "string"),
          }));
        const { canceled, filePaths } = await dialog.showOpenDialog(win, {
          properties: ["openFile"],
          filters: wellFormed,
        });
        return canceled || !filePaths[0] ? null : filePaths[0];
      },
    },
    // Reveal a path in the OS file manager: open a directory window, or select a
    // file inside its parent folder. Backs Export's "Open Folder" action.
    {
      channel: "fs:reveal",
      privileged: true,
      handler: async (_e, p) => {
        try {
          const st = await fs.promises.stat(p);
          if (st.isDirectory()) {
            // openPath resolves to "" on success, or an error string otherwise.
            return (await shell.openPath(p)) === "";
          }
          shell.showItemInFolder(p);
          return true;
        } catch {
          return false;
        }
      },
    },
  ];
}

module.exports = { fsChannels };
