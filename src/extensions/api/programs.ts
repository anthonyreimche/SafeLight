// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The shapes of api.programs: running a native program the person chose.

/** A program the person allowed this extension to run. `token` is what
 *  `run` and `forget` take; the extension never holds anything it could run
 *  without it. */
export interface KeptProgram {
  token: string;
  /** The program's full path, for showing. */
  path: string;
  /** The file's own name, such as `gmic.exe`. */
  name: string;
}

export interface ProgramRunOptions {
  /** Files written into the run's empty folder before the program starts. The
   *  program runs with that folder as its working directory. Names are plain:
   *  letters, digits, `.`, `_` and `-`, up to 128, no names Windows reserves
   *  (`con`, `nul`, `com1`…) and none that differ only by case. */
  files?: Record<string, Uint8Array>;
  /** Files to read back from that folder once the program ends, by name. A
   *  name ending in `*` takes every file that starts with the rest
   *  (`"out_*"`), in the folder only. Missing files are left out. At most 16
   *  files and 1 GB come back; more rejects the run. */
  outputs?: string[];
  /** Stops the program. The run then resolves with `killed: "cancelled"`. */
  signal?: AbortSignal;
  /** Stops the program after this long: 10 minutes when left out, 2 hours at
   *  most. */
  timeoutMs?: number;
  /** What the program prints, as it arrives, in pieces that never cut a
   *  character in half. Delivered a few times a second, not once per line. */
  onOutput?(stream: "stdout" | "stderr", text: string): void;
}

export interface ProgramRunResult {
  /** The program's exit code, or null when it was stopped. */
  exitCode: number | null;
  killed: "timeout" | "cancelled" | null;
  /** The last 4 MB of what the program printed on each stream. */
  stdout: string;
  stderr: string;
  /** The files asked for in `outputs`. Empty when the program was stopped. */
  files: Record<string, Uint8Array>;
}

/** Runs one native program the person chose, such as the `gmic` command-line
 *  program. The extension declares `"permissions": { "programs": true }`. The
 *  person picks the program in the system's file dialogue (or has Safelight
 *  look for it on `PATH`) and confirms in a second dialogue that names the
 *  extension and the full path; the extension then holds a token for it, never
 *  the right to name another program. The grant lasts across launches, until
 *  the person forgets it on the extension's page in the Extensions window or
 *  the extension is uninstalled; an update keeps it.
 *
 *  A run starts the program directly, with no shell, in a fresh empty folder
 *  that is removed afterwards. It is an ordinary program with the person's own
 *  rights: it can read, change and delete their files. Other extensions that
 *  run this extension's commands (Terminal, say) reach it through them. On
 *  Windows the program must be an `.exe` or `.com`. Needs Safelight 3.2.6. */
export interface ProgramsAPI {
  /** The system's file dialogue, then the consent dialogue. Kept for this
   *  extension across launches. Null when the person cancels or refuses.
   *  Ask from a click. `replacing` is a token this pick takes the place of:
   *  the dialogue opens beside it, and it is forgotten once the new one is
   *  kept. */
  pick(options?: { title?: string; replacing?: string | null }): Promise<KeptProgram | null>;
  /** Looks for `name` (such as `"gmic"`) on `PATH`, and on macOS and Linux in
   *  `/opt/homebrew/bin`, `/usr/local/bin` and `/usr/bin`, and asks for
   *  consent exactly as `pick` does. Null when it isn't found or the person
   *  refuses. */
  locate(name: string): Promise<KeptProgram | null>;
  /** The programs kept for this extension. */
  list(): Promise<KeptProgram[]>;
  /** Stops allowing the program. */
  forget(token: string): Promise<void>;
  /** Runs a kept program with `args`, each its own argument. Rejects when the
   *  token isn't this extension's, the file is gone, the program can't start,
   *  or the files, names or arguments are refused (at most 4096 arguments,
   *  each up to 32 KB). A program that runs and fails is not a rejection: look
   *  at `exitCode`. Rejects with "NotSupportedError" outside the desktop
   *  app. */
  run(token: string, args: string[], options?: ProgramRunOptions): Promise<ProgramRunResult>;
}
