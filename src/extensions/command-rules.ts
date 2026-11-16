// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The rules an extension's console command keeps, shared by the app, the
// engine and the `safelight` CLI. Free of the DOM.

import { isSupportedName } from "@/catalog/photo-names";

/** A command's verb: a lower-case letter, then 1 to 31 lower-case letters,
 *  digits or "-". */
export const COMMAND_NAME = /^[a-z][a-z0-9-]{1,31}$/;

/** The `safelight` verbs and their aliases, and the words the prompt keeps for
 *  itself. Checked against the CLI's own lists by its tests. */
export const RESERVED_COMMAND_NAMES: ReadonlySet<string> = new Set([
  "photos", "tools", "get", "history", "preview", "view", "ls", "import", "open", "rotate", "keywords",
  "forget", "set", "add", "remove", "reset", "auto", "undo", "redo", "copy", "paste", "presets", "apply",
  "save-preset", "rate", "flag", "label", "export", "search", "install", "uninstall", "update",
  "extensions", "enable", "disable", "doctor", "version", "help",
  "cd", "next", "prev", "close", "home", "clear", "cls", "exit", "quit",
]);

/** Why `name` can't be a command's verb, or null when it can. */
export function commandNameRefusal(name: unknown): string | null {
  if (typeof name !== "string" || !COMMAND_NAME.test(name)) {
    return `"${String(name)}" isn't a command name (a lower-case letter, then 1 to 31 lower-case letters, digits or "-")`;
  }
  if (RESERVED_COMMAND_NAMES.has(name)) return `"${name}" is one of Safelight's own commands`;
  return null;
}

/** A saved result's suffix: 1 to 32 lower-case letters, digits or "-". */
export const SAVE_SUFFIX = /^[a-z0-9-]{1,32}$/;

/** The most names a save tries before giving up: "-2" to "-99". */
export const MAX_SAVE_TRIES = 99;

/** `ext` as a saved result's extension ("png" from ".PNG"), or null when it
 *  isn't a photo type Safelight opens. */
export function saveExtension(ext: unknown): string | null {
  if (typeof ext !== "string") return null;
  const clean = ext.replace(/^\./, "").toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(clean) && isSupportedName(`x.${clean}`) ? clean : null;
}

/** Why a result can't be saved with this suffix and extension, or null. */
export function saveRefusal(suffix: unknown, ext: unknown): string | null {
  if (typeof suffix !== "string" || !SAVE_SUFFIX.test(suffix)) {
    return `The suffix "${String(suffix)}" isn't 1 to 32 lower-case letters, digits or "-".`;
  }
  if (saveExtension(ext) === null) return `".${String(ext)}" isn't a type of photo Safelight opens.`;
  return null;
}

/** The name the `n`th try saves a result of the photo shown as `displayName`
 *  under: "IMG_1-gmic.png", then "IMG_1-gmic-2.png". */
export function saveName(displayName: string, suffix: string, ext: string, n: number): string {
  const base = displayName.replace(/\.[^.]*$/, "") || displayName;
  return `${base}-${suffix}${n > 1 ? `-${n}` : ""}.${ext}`;
}

/** Why nothing can be saved into the project folder `folder` ("" is the root). */
export const readOnlyFolder = (folder: string): string =>
  folder ? `The folder “${folder}” is read-only.` : "The project folder is read-only.";
