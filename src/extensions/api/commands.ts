// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// ---------------------------------------------------------------------------
// Console commands (api.commands)
// ---------------------------------------------------------------------------

import type { CatalogPhoto } from "@/catalog/types";

/** A line of progress a command shows while it works. */
export interface CommandProgress {
  /** Replace the line; `fraction` (0 to 1) shows how far along it is. */
  update(text: string, fraction?: number): void;
  /** Take the line away, leaving `text` as a note when given. */
  done(text?: string): void;
}

/** Where a command's output goes. */
export interface CommandOutput {
  /** Plain output: the lines a person, or a script reading the CLI's output,
   *  asked for. */
  print(text: string): void;
  /** A dim note about what the command is doing. */
  info(text: string): void;
  warn(text: string): void;
  progress(text: string): CommandProgress;
}

/** What a command gets when it runs. */
export interface CommandRunContext extends CommandOutput {
  /** The words after the verb, as typed: nothing is read as an option, so
   *  "-blur" stays a word. */
  words: string[];
  /** The photos it acts on: the Terminal's targets (the Develop photo or the
   *  Library selection), or the photos the CLI chose. May be empty. */
  photos: CatalogPhoto[];
  /** "app" when it runs in Safelight (the Terminal, or another extension
   *  through `run`), "cli" when the `safelight` command runs it. */
  caller: "app" | "cli";
  /** The extension id that ran it, or "cli". */
  from: string;
  /** Aborts when the person stops the command (Ctrl+C, the Terminal's stop).
   *  Stop at the next point you can. */
  signal: AbortSignal;
  /** Null when a result can be saved beside `photo`, else why not (the
   *  photo's folder is read-only, the project is a library source). Ask
   *  before long work whose result would have nowhere to go. */
  canSaveBeside(photo: CatalogPhoto): Promise<string | null>;
  /** Save `data` as a new photo in `photo`'s folder, named
   *  "<name>-<suffix>.<ext>" after the photo (a virtual copy's name included),
   *  or "<name>-<suffix>-2.<ext>" and on while a name is taken; nothing is
   *  overwritten. `suffix` is 1 to 32 lower-case letters, digits or "-", and
   *  `ext` a photo type Safelight opens ("png", "tif", "jpg"). Resolves with
   *  the new file's name once it is a photo of the catalogue: in the app it
   *  is imported at once; under the CLI it is written now and imported when
   *  the command ends. Rejects with the reason it couldn't be saved. */
  saveBeside(photo: CatalogPhoto, data: Blob, suffix: string, ext: string): Promise<string>;
  /** A structured result, printed by `safelight … --json` and handed back by
   *  `run`. The last call wins; plain JSON data only. */
  result(value: unknown): void;
}

/** A console verb. */
export interface CommandContribution {
  /** The verb: a lower-case letter, then 1 to 31 lower-case letters, digits
   *  or "-". A `safelight` verb, one of the prompt's own words (cd, next,
   *  prev, close, home, clear, cls, exit, quit, open) or a verb another
   *  extension holds is refused with a warning. */
  name: string;
  /** One line about what it does. */
  summary: string;
  /** One line per form, without "safelight": "gmic <pipeline…>". */
  usage: string[];
  /** Whole lines that run it: "gmic blur 3". */
  examples?: string[];
  /** The words that may come first, for help and completion. */
  subcommands?: { name: string; summary: string }[];
  /** Runs the command. A throw ends it with the error's message. */
  run(ctx: CommandRunContext): Promise<void>;
}

/** A command as `list` gives it. */
export interface RegisteredCommand {
  name: string;
  summary: string;
  usage: string[];
  examples: string[];
  subcommands: { name: string; summary: string }[];
  /** The extension that registered it. */
  extensionId: string;
}

/** Verbs an extension adds to Safelight's consoles. A command registered here
 *  runs in the app through `run` (the Terminal extension's console), and one
 *  the manifest also declares under `commands` runs from the `safelight` CLI
 *  too, as `safelight <name> <words…> [-- photos…]`. Dropped when the
 *  extension stops. Needs Safelight 3.2.6. */
export interface CommandsAPI {
  /** Add a command, or replace one of your own by name. */
  register(c: CommandContribution): void;
  /** Remove a command you registered. */
  unregister(name: string): void;
  /** Every extension's commands, by name. */
  list(): RegisteredCommand[];
  /** Called when the list changes. Returns the unsubscribe function. */
  subscribe(cb: () => void): () => void;
  /** Run a registered command with `words` on `photos`, its output going to
   *  the functions given. Resolves with its `result` (undefined when it gave
   *  none) and the names it saved; rejects with the command's own error, or
   *  for a name nobody registered. Needs `"permissions": { "commands": true }`
   *  in your manifest; without it the call rejects with a NotAllowedError. */
  run(
    name: string,
    options: CommandOutput & { words: string[]; photos: CatalogPhoto[]; signal?: AbortSignal },
  ): Promise<{ result: unknown; saved: string[] }>;
  /** Null when a result can be saved beside `photo`, else why not: the run
   *  context's canSaveBeside, for a panel of your own. No permission needed. */
  canSaveBeside(photo: CatalogPhoto): Promise<string | null>;
  /** Save `data` as a new photo beside `photo` and import it, exactly as the
   *  run context's saveBeside does in the app; resolves with the new file's
   *  name. No permission needed: it only writes into the open project, beside
   *  a photo of it. */
  saveBeside(photo: CatalogPhoto, data: Blob, suffix: string, ext: string): Promise<string>;
}
