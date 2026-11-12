// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The kept-folder members of api.project: a folder the person picked, opened
// again in a later launch by the token the extension stored. On the desktop the
// main process shows the dialog and keeps the record (electron/kept-folders.cjs)
// over the privileged bridge core holds, so the id it names is the calling
// extension's own and no extension can have a path of its choosing opened. The
// browser build keeps a picked handle until the page loads again: its
// permission lapses with the page anyway.

import type { SafelightAPI } from "./api/scoped-api";
import type { NativeFsBridge } from "./api/native-bridge";
import { nativeDirectoryHandle, nativeFs, pickDirectoryHandle } from "@/project/native-fs";

type KeptMembers = Pick<SafelightAPI["project"], "pickKeptDirectory" | "openKeptDirectory" | "forgetKeptDirectory">;

interface KeptDeps {
  bridge: () => NativeFsBridge | null;
  handleFor: (path: string) => FileSystemDirectoryHandle;
  pickBrowser: (id: string) => Promise<FileSystemDirectoryHandle | null>;
}

const DEFAULTS: KeptDeps = { bridge: nativeFs, handleFor: nativeDirectoryHandle, pickBrowser: pickDirectoryHandle };

/** Folders picked in the browser build this page load, by token. */
const pagePicked = new Map<string, { extensionId: string; folder: FileSystemDirectoryHandle }>();

export function keptDirectoriesAPI(extensionId: string, deps: KeptDeps = DEFAULTS): KeptMembers {
  const desktop = () => {
    const fs = deps.bridge();
    return fs?.pickKeptFolder && fs.keptFolder && fs.forgetKeptFolder
      ? { pick: fs.pickKeptFolder, open: fs.keptFolder, forget: fs.forgetKeptFolder }
      : null;
  };
  return {
    pickKeptDirectory: async (id, replacing) => {
      const native = desktop();
      if (native) {
        const kept = await native.pick(extensionId, replacing ?? null);
        return kept ? { token: kept.token, folder: deps.handleFor(kept.path) } : null;
      }
      const folder = await deps.pickBrowser(id);
      if (!folder) return null;
      const token = crypto.randomUUID();
      pagePicked.set(token, { extensionId, folder });
      return { token, folder };
    },
    openKeptDirectory: async (token) => {
      const native = desktop();
      if (native) {
        const kept = await native.open(extensionId, token);
        return "path" in kept ? { folder: deps.handleFor(kept.path) } : { problem: kept.error };
      }
      const held = pagePicked.get(token);
      return held?.extensionId === extensionId ? { folder: held.folder } : { problem: "unknown" };
    },
    forgetKeptDirectory: async (token) => {
      const native = desktop();
      if (native) return native.forget(extensionId, token);
      if (pagePicked.get(token)?.extensionId === extensionId) pagePicked.delete(token);
    },
  };
}
