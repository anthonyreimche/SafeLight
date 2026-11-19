// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// api.commands in the app: commands go into the registry's `commands` kind,
// and `run` builds the context the Terminal's console runs one with. A result
// saved beside a photo is imported into the open project at once. The engine
// builds its own context for the `safelight` CLI (engine/session.ts).

import type { CatalogPhoto } from "@/catalog/types";
import { photoDisplayName } from "@/catalog/copy-name";
import { importFiles } from "@/modules/library/import-files";
import { folderSegments } from "@/project/entry-names";
import { sourceRefOf } from "@/project/library-sources";
import { nativeFs, nativePathOf } from "@/project/native-fs";
import { useProjectStore } from "@/project/project-store";
import { useCatalogStore } from "@/state/catalog-store";
import type { CommandRunContext, CommandsAPI } from "./api/commands";
import { mayRunCommands } from "./command-permissions";
import { MAX_SAVE_TRIES, readOnlyFolder, saveExtension, saveName, saveRefusal } from "./command-rules";
import { trackSubscription } from "./guard";
import { listCommands, registerCommand, registeredCommand, unregisterCommand, useRegistry } from "./registry";

export interface CommandHostDeps {
  importFiles: typeof importFiles;
  /** The open project's folder on disk, or null when it is none (a library
   *  source, a folder the browser build opened). */
  rootPath(root: FileSystemDirectoryHandle): string | null;
  /** Whether a file can be written into the folder at `dir` now. */
  canWrite(dir: string): Promise<boolean>;
}

/** Writes and removes a hidden file, which the project scan skips: the only
 *  sure sign on every platform that the folder takes writes. */
export async function canWriteFolder(dir: string): Promise<boolean> {
  const fs = nativeFs();
  if (!fs) return false;
  const probe = `${dir.replace(/[/\\]+$/, "")}/.sl-write-${crypto.randomUUID()}`;
  try {
    await fs.write(probe, new Uint8Array(0));
  } catch {
    return false;
  }
  await fs.remove(probe).catch(() => {});
  return true;
}

const DEFAULT_DEPS: CommandHostDeps = {
  importFiles,
  rootPath: (root) => (sourceRefOf(root) ? null : nativePathOf(root)),
  canWrite: canWriteFolder,
};

const IN_USE = /already exists/i;

type Placed = { photo: CatalogPhoto; dir: string } | { problem: string };

/** Where a result of `photo` would go: the catalogue's record of it and its
 *  folder on disk, or why there is nowhere. The record is looked up by id, so
 *  a folder or name on the object passed in is never trusted. */
function place(deps: CommandHostDeps, photo: CatalogPhoto): Placed {
  const id: unknown = photo?.id;
  const record = useCatalogStore.getState().photos.find((p) => p.id === id);
  const root = useProjectStore.getState().root;
  if (!root) return { problem: "No project is open." };
  if (!record) return { problem: "This photo isn't in the open project." };
  const rootPath = deps.rootPath(root);
  if (rootPath === null) return { problem: "Results can only be saved into a folder on disk, in the desktop app." };
  const segments = folderSegments(record.folder);
  if (segments === null) return { problem: "This photo's folder isn't one Safelight can save into." };
  const base = rootPath.replace(/[/\\]+$/, "");
  return { photo: record, dir: segments.length === 0 ? base : `${base}/${segments.join("/")}` };
}

async function canSaveBeside(deps: CommandHostDeps, photo: CatalogPhoto): Promise<string | null> {
  const placed = place(deps, photo);
  if ("problem" in placed) return placed.problem;
  if (!(await deps.canWrite(placed.dir))) return readOnlyFolder(placed.photo.folder);
  return null;
}

async function saveBeside(deps: CommandHostDeps, photo: CatalogPhoto, data: Blob, suffix: string, ext: string): Promise<string> {
  const refusal = saveRefusal(suffix, ext);
  if (refusal) throw new Error(refusal);
  if (!(data instanceof Blob)) throw new Error("The data to save must be a Blob.");
  const placed = place(deps, photo);
  if ("problem" in placed) throw new Error(placed.problem);
  const type = saveExtension(ext) ?? "";
  const shown = photoDisplayName(placed.photo);
  for (let n = 1; n <= MAX_SAVE_TRIES; n++) {
    const name = saveName(shown, suffix, type, n);
    const [result] = await deps.importFiles([{ name, data }], { folder: placed.photo.folder });
    if (!result) throw new Error("Nothing was imported.");
    if ("id" in result) return name;
    if (!IN_USE.test(result.error)) throw new Error(result.error);
  }
  throw new Error(`Every name up to ${saveName(shown, suffix, type, MAX_SAVE_TRIES)} is in use.`);
}

const notAllowed = (extensionId: string): DOMException =>
  new DOMException(
    `${extensionId} can't run commands: its manifest doesn't declare "permissions": { "commands": true }.`,
    "NotAllowedError",
  );

/** The commands API of extension `extensionId`. */
export function commandsAPI(extensionId: string, over: Partial<CommandHostDeps> = {}): CommandsAPI {
  const deps: CommandHostDeps = { ...DEFAULT_DEPS, ...over };
  return {
    register: (c) => registerCommand(extensionId, c),
    unregister: (name) => unregisterCommand(extensionId, name),
    list: listCommands,
    subscribe: trackSubscription(extensionId, (cb: () => void) =>
      useRegistry.subscribe((s, prev) => {
        if (s.commands === prev.commands) return;
        try {
          cb();
        } catch (e) {
          console.warn(`[extensions] ${extensionId}: its commands listener threw:`, e);
        }
      }),
    ),
    canSaveBeside: (photo) => canSaveBeside(deps, photo),
    saveBeside: (photo, data, suffix, ext) => saveBeside(deps, photo, data, suffix, ext),
    run: async (name, options) => {
      if (!mayRunCommands(extensionId)) throw notAllowed(extensionId);
      const entry = registeredCommand(String(name));
      if (!entry) throw new Error(`No extension registered the command "${String(name)}".`);
      if (!Array.isArray(options.words) || !options.words.every((w) => typeof w === "string")) {
        throw new TypeError("run: words must be a list of strings");
      }
      if (!Array.isArray(options.photos)) throw new TypeError("run: photos must be a list of photos");
      const saved: string[] = [];
      let result: unknown;
      const ctx: CommandRunContext = {
        words: [...options.words],
        photos: [...options.photos],
        caller: "app",
        from: extensionId,
        signal: options.signal ?? new AbortController().signal,
        print: (text) => options.print(String(text)),
        info: (text) => options.info(String(text)),
        warn: (text) => options.warn(String(text)),
        progress: (text) => options.progress(String(text)),
        canSaveBeside: (photo) => canSaveBeside(deps, photo),
        saveBeside: async (photo, data, suffix, ext) => {
          const savedName = await saveBeside(deps, photo, data, suffix, ext);
          saved.push(savedName);
          return savedName;
        },
        result: (value) => {
          result = value;
        },
      };
      await entry.run(ctx);
      return { result, saved };
    },
  };
}
