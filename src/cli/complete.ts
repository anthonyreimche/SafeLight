// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Tab completion for the prompt: verbs, a verb's options, photo and folder
// names, value keys after a photo, installed extension names. It reads the
// folder being completed and nothing else, so it never waits on the engine.

import { homedir } from "node:os";
import path from "node:path";
import { findCommand, GLOBAL_OPTIONS } from "./args";
import { tokenize, type Token } from "./line-split";
import { type CommandSpec, COMMAND } from "./types";

export interface DirEntry { name: string; dir: boolean }

export interface CompleteDeps {
  platform: NodeJS.Platform;
  cwd(): string;
  commands: readonly CommandSpec[];
  /** Words the prompt itself understands (exit, cd, …). */
  builtins: readonly string[];
  readDir(dir: string): Promise<DirEntry[]>;
  /** Keys `set`, `get` and `reset` take, from the values service. */
  valueKeys(): string[];
  /** Installed extensions' names as `install` and `uninstall` take them. */
  extensionNames(): string[];
}

/** node:readline's completer: the replacements, and the text of the line they replace. */
export type Completer = (line: string) => Promise<[string[], string]>;

const PHOTO_EXTENSIONS = new Set([
  "3fr", "arw", "cr2", "cr3", "crw", "dcr", "dng", "erf", "iiq", "kdc", "mef", "mos", "mrw", "nef", "nrw",
  "orf", "pef", "raf", "raw", "rw2", "rwl", "sr2", "srf", "srw", "x3f",
  "jpg", "jpeg", "png", "tif", "tiff", "webp", "heic", "heif", "avif",
]);

const EXTENSION_VERBS = new Set(["uninstall", "enable", "disable", "update"]);
const KEY_VERBS = new Set(["set", "get", "reset"]);

const isPhotoName = (name: string): boolean => PHOTO_EXTENSIONS.has(path.extname(name).slice(1).toLowerCase());

function startsWith(name: string, prefix: string, fold: boolean): boolean {
  return fold ? name.toLowerCase().startsWith(prefix.toLowerCase()) : name.startsWith(prefix);
}

/** A word that is the start of a photo path or an option, not a key=value. */
const isPhotoWord = (word: Token): boolean => !word.text.startsWith("-") && !word.text.includes("=");

function quoted(value: string, current: Token | null, closed: boolean): string {
  const quote = current?.quote ?? (/[\s"']/.test(value) ? "\"" : null);
  return quote === null ? value : `${quote}${value}${closed ? quote : ""}`;
}

export function createCompleter(deps: CompleteDeps): Completer {
  const p = deps.platform === "win32" ? path.win32 : path.posix;
  const fold = deps.platform === "win32" || deps.platform === "darwin";
  const verbNames = [...deps.commands.map((c) => c.verb), ...deps.builtins];

  const fromList = (candidates: readonly string[], typed: string): string[] =>
    [...new Set(candidates)].filter((c) => startsWith(c, typed, fold)).sort();

  async function paths(current: Token | null, dirsOnly: boolean): Promise<string[]> {
    const typed = current?.text ?? "";
    const separators = deps.platform === "win32" ? /[\/][^\/]*$/ : /\/[^/]*$/;
    const cut = separators.exec(typed);
    const dirPart = cut ? typed.slice(0, cut.index + 1) : "";
    const base = cut ? typed.slice(cut.index + 1) : typed;
    const expanded = dirPart.startsWith("~") ? homedir() + dirPart.slice(1) : dirPart;
    const dir = expanded === "" ? deps.cwd() : p.resolve(deps.cwd(), expanded);
    const entries = await deps.readDir(dir).catch(() => []);
    const showHidden = base.startsWith(".");
    const matching = entries.filter((e) =>
      startsWith(e.name, base, fold) && (showHidden || !e.name.startsWith(".")) && (!dirsOnly || e.dir));
    const favoured = matching.filter((e) => e.dir || isPhotoName(e.name));
    const chosen = favoured.length > 0 || dirsOnly ? favoured : matching;
    const sep = dirPart.includes("/") || deps.platform !== "win32" ? "/" : "\\";
    return chosen
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
      .map((e) => quoted(`${dirPart}${base}${e.name.slice(base.length)}${e.dir ? sep : ""}`, current, !e.dir));
  }

  return async (line) => {
    const tokens = tokenize(line, deps.platform);
    const last = tokens[tokens.length - 1];
    const current = last && (last.open || last.end === line.length) ? last : null;
    const completeOn = current ? line.slice(current.start) : "";
    const typed = current?.text ?? "";
    let words = current ? tokens.slice(0, -1) : tokens;
    if (words[0]?.text === COMMAND) words = words.slice(1);

    const reply = (hits: string[]): [string[], string] => [hits, completeOn];
    const verb = words[0]?.text;
    if (verb === undefined) {
      return reply(typed.startsWith("-") ? [] : fromList(verbNames, typed));
    }
    const spec = findCommand(deps.commands, verb);

    if (typed.startsWith("-")) {
      const names = [...GLOBAL_OPTIONS, ...(spec?.options ?? [])].map((o) => `--${o.name}`);
      return reply(typed.includes("=") ? [] : fromList(names, typed));
    }
    if (verb === "help") return reply(words.length === 1 ? fromList(deps.commands.map((c) => c.verb), typed) : []);
    if (EXTENSION_VERBS.has(verb)) return reply(fromList(deps.extensionNames(), typed));
    if (typed.includes("=")) return reply([]);
    if (verb === "cd") return reply(words.length === 1 ? await paths(current, true) : []);

    const keys = KEY_VERBS.has(verb) && words.slice(1).some(isPhotoWord)
      ? fromList(deps.valueKeys(), typed).map((k) => (verb === "set" ? `${k}=` : k))
      : [];
    return reply([...keys, ...(await paths(current, false))]);
  };
}
