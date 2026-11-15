// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The prompt: `safelight` with no arguments on a terminal. It reads a line,
// runs it through main() as if it had followed `safelight` in a shell, and asks
// again. Each command opens and closes its own sessions, so the project lock is
// never held while the prompt waits.

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { readLock, STALE_MS } from "../../electron/file-lock.cjs";
import { findCommand } from "./args";
import { createCompleter, type DirEntry } from "./complete";
import { gpuItem, guiLooksRunning } from "./commands/doctor";
import { DEFAULT_FACTORIES, type ServiceFactories } from "./context";
import { createEngineClient, createEngineSession } from "./engine-client";
import { cliEnv } from "./env";
import { installedManifests, slugOf } from "./extensions";
import { installNodeHost } from "./host";
import { splitLine } from "./line-split";
import { main, type MainIO } from "./main";
import { readSharedSettings } from "./mirror";
import { createNodeFsBridge } from "./node-fs";
import { createOutput, formatHome, formatPrompt, formatReplNote, resolveOutputOptions } from "./output";
import type { HomeStatus, OutputOptions, PromptState, ReplNoteKind } from "./output/types";
import { createProjectService } from "./project";
import { isEdited } from "./select";
import { closest } from "./suggest";
import { type CliEnv, type CommandSpec, type ExitCode, COMMAND } from "./types";

export const HISTORY_LIMIT = 1000;
const DOUBLE_INTERRUPT_MS = 2000;
export const BUILTINS = ["exit", "quit", "clear", "cls", "cd", "home"] as const;

/** Verbs after which the extension names and value keys may have changed. */
const CHANGES_EXTENSIONS = new Set(["install", "uninstall", "enable", "disable", "update"]);

export interface ReplVisuals {
  formatHome(status: HomeStatus, opts: OutputOptions): string;
  formatPrompt(state: PromptState, opts: OutputOptions): string;
  formatReplNote(kind: ReplNoteKind, opts: OutputOptions, text?: string): string;
}

/** What the prompt looks up; tests swap these for fakes. */
export interface ReplDeps {
  visuals: ReplVisuals;
  status(env: CliEnv): Promise<HomeStatus>;
  /** The name of the project holding `env.cwd`, or null. */
  projectName(env: CliEnv): Promise<string | null>;
  chdir(dir: string): void;
  isDirectory(dir: string): Promise<boolean>;
  now(): number;
}

// ---- history -----------------------------------------------------------------

/** `list` with `line` added at the end: unchanged when it repeats the last line, the oldest dropped past the cap. */
export function pushHistory(list: readonly string[], line: string, limit: number = HISTORY_LIMIT): string[] {
  if (line.trim() === "" || list[list.length - 1] === line) return [...list];
  return [...list, line].slice(-limit);
}

export async function loadHistory(file: string, limit: number = HISTORY_LIMIT): Promise<string[]> {
  const text = await readFile(file, "utf8").catch(() => "");
  return text.split(/\r?\n/).reduce<string[]>((kept, line) => pushHistory(kept, line, limit), []);
}

export async function saveHistory(file: string, lines: readonly string[]): Promise<void> {
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${lines.join("\n")}\n`);
  } catch {
    // History is a convenience; a read-only profile must not stop the prompt.
  }
}

export const historyFile = (userData: string): string => path.join(userData, "slu", "history");

// ---- status ------------------------------------------------------------------

async function guiHoldsLock(workingDir: string): Promise<boolean> {
  const lock = await readLock(path.join(workingDir, "writer.lock"));
  return lock !== null && lock.app === "safelight" && Date.now() - lock.refreshedAt < STALE_MS;
}

function installHost(env: CliEnv): ReturnType<typeof createNodeFsBridge> {
  const bridge = createNodeFsBridge(env.userData);
  installNodeHost({ bridge, platform: env.platform, storage: readSharedSettings(env.userData)?.storage ?? {} });
  return bridge;
}

/** The home screen's facts, from files only: no engine, no network. */
export async function homeStatus(env: CliEnv): Promise<HomeStatus> {
  const shared = readSharedSettings(env.userData);
  const graphics = await gpuItem({ env });
  const projects = createProjectService(env, installHost(env));
  const ref = await projects.find(env.cwd);

  let project: HomeStatus["project"] = null;
  let guiHasProjectOpen = false;
  if (ref) {
    let photos = 0;
    let edited = 0;
    try {
      const session = await projects.openRead(ref);
      try {
        const all = session.photos();
        photos = all.length;
        edited = (await Promise.all(all.map((p) => session.edit(p.id)))).filter(isEdited).length;
      } finally {
        await session.close();
      }
    } catch {
      // A catalogue that won't open is still a project; the counts stay 0.
    }
    project = { root: ref.root, name: path.basename(ref.root) || ref.root, photos, edited };
    guiHasProjectOpen = guiLooksRunning(shared) && (await guiHoldsLock(ref.workingDir));
  }

  return {
    version: env.appVersion,
    cwd: env.cwd,
    project,
    guiHasProjectOpen,
    graphics: graphics.status === "info" ? null : graphics.value,
    settingsShared: shared !== null,
    extensions: { installed: installedManifests(env.userData).length, updates: null },
  };
}

async function findProjectName(env: CliEnv): Promise<string | null> {
  const ref = await createProjectService(env, createNodeFsBridge(env.userData)).find(env.cwd);
  return ref ? path.basename(ref.root) || ref.root : null;
}

const isDirectory = (dir: string): Promise<boolean> => stat(dir).then((s) => s.isDirectory(), () => false);

const readDirEntries = async (dir: string): Promise<DirEntry[]> =>
  (await readdir(dir, { withFileTypes: true })).map((e) => ({ name: e.name, dir: e.isDirectory() }));

export const DEFAULT_REPL_DEPS: ReplDeps = {
  visuals: { formatHome, formatPrompt, formatReplNote },
  status: homeStatus,
  projectName: findProjectName,
  chdir: (dir) => process.chdir(dir),
  isDirectory,
  now: () => Date.now(),
};

// ---- the loop ----------------------------------------------------------------

type Read = { kind: "line"; text: string } | { kind: "interrupt"; text: string } | { kind: "eof" };

export async function runRepl(io: MainIO, overrides: Partial<ReplDeps> = {}): Promise<ExitCode> {
  const deps: ReplDeps = { ...DEFAULT_REPL_DEPS, ...overrides };
  const { visuals } = deps;
  const streams = { stdout: io.stdout, stderr: io.stderr };
  const baseEnv = cliEnv({
    cwd: io.cwd,
    env: io.env,
    platform: io.platform,
    home: io.home,
    isTTY: { stdin: true, stdout: true, stderr: io.stderr.isTTY === true },
    moduleFile: io.moduleFile,
  });
  let cwd = io.cwd;
  const envNow = (): CliEnv => ({ ...baseEnv, cwd });
  const options = (): OutputOptions => resolveOutputOptions(streams, io.env, "normal");
  const commands: readonly CommandSpec[] = io.commands ?? (await import("./commands")).COMMANDS;

  const engines = createEngineSession((out) => createEngineClient(envNow(), out));
  const services: Partial<ServiceFactories> = { ...io.services, engine: (_env, out) => engines.client(out) };

  const say = (kind: ReplNoteKind, text?: string, stream: "stdout" | "stderr" = "stdout"): void => {
    io[stream].write(`${visuals.formatReplNote(kind, options(), text)}\n`);
  };
  const fail = (message: string): void => createOutput(streams, options()).error({ message });

  const file = historyFile(baseEnv.userData);
  let history = await loadHistory(file);

  let valueKeys: string[] | null = null;
  const completer = createCompleter({
    platform: io.platform,
    cwd: () => cwd,
    commands,
    builtins: BUILTINS,
    readDir: readDirEntries,
    valueKeys: () => {
      if (valueKeys === null) {
        try {
          installHost(envNow());
          valueKeys = DEFAULT_FACTORIES.values(envNow()).values().filter((v) => v.settable).map((v) => v.key);
        } catch {
          valueKeys = [];
        }
      }
      return valueKeys;
    },
    extensionNames: () => installedManifests(baseEnv.userData).map((m) => slugOf(m.name)),
  });

  let projectName: string | null = null;
  const refreshProject = async (): Promise<void> => {
    projectName = await deps.projectName(envNow()).catch(() => null);
  };

  // One readline serves the whole session. Lines that arrive while a command runs wait in
  // `inbox`; a command's question takes the next one.
  const inbox: Read[] = [];
  let waiting: ((item: Read) => void) | null = null;
  let closed = false;
  let running = false;
  let cancelRunning: (() => void) | null = null;

  const deliver = (item: Read): void => {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(item);
    } else inbox.push(item);
  };
  const take = (): Promise<Read> => {
    const next = inbox.shift();
    if (next) return Promise.resolve(next);
    if (closed) return Promise.resolve({ kind: "eof" });
    return new Promise((resolve) => { waiting = resolve; });
  };
  // Ctrl+C on a running command cancels it and the lines pasted after it.
  const stopRunning = (): void => {
    if (!running) return;
    inbox.length = 0;
    cancelRunning?.();
    // A command waiting on an answer stops waiting.
    if (waiting) deliver({ kind: "interrupt", text: "" });
  };

  const rl = createInterface({
    input: io.stdin,
    output: io.stdout,
    terminal: true,
    history: [...history].reverse(),
    historySize: HISTORY_LIMIT,
    completer: (line: string, done: (err: Error | null, result: [string[], string]) => void) => {
      completer(line).then((result) => done(null, result), () => done(null, [[], line]));
    },
  });
  rl.on("line", (text) => deliver({ kind: "line", text }));
  rl.on("SIGINT", () => {
    if (running) stopRunning();
    else deliver({ kind: "interrupt", text: rl.line });
  });
  rl.on("close", () => {
    closed = true;
    if (waiting) deliver({ kind: "eof" });
  });

  const ask = async (question: string): Promise<string> => {
    io.stderr.write(question);
    const answer = await take();
    return answer.kind === "line" ? answer.text : "";
  };

  const showHome = async (): Promise<void> => {
    io.stdout.write(visuals.formatHome(await deps.status(envNow()), options()));
  };

  const dispatch = async (words: string[]): Promise<void> => {
    const stopListening = io.onInterrupt(stopRunning);
    running = true;
    try {
      const code = await main(words, {
        ...io,
        cwd,
        commands,
        services,
        quietStop: true,
        ask,
        onInterrupt(handler) {
          cancelRunning = handler;
          return () => { cancelRunning = null; };
        },
      });
      if (code === 130) {
        inbox.length = 0;
        // The engine may still be on the stopped command's job.
        await engines.close();
        say("cancelled");
      }
    } finally {
      running = false;
      stopListening();
    }
  };

  const changeFolder = async (words: string[]): Promise<void> => {
    const rest = words.slice(1);
    if (rest[0]?.toLowerCase() === "/d") rest.shift();
    if (rest.length === 0) {
      io.stdout.write(`${cwd}\n`);
      return;
    }
    const typed = rest[0];
    const wanted = /^~([\\/]|$)/.test(typed) ? path.join(homedir(), typed.slice(1)) : typed;
    const target = path.resolve(cwd, wanted);
    if (!(await deps.isDirectory(target))) {
      fail(`${typed} isn't a folder.`);
      return;
    }
    deps.chdir(target);
    cwd = target;
    await refreshProject();
  };

  const unknown = (word: string, line: string): void => {
    const names = [...commands.flatMap((c) => [c.verb, ...(c.aliases ?? [])]), ...BUILTINS];
    const guess = closest(word, names);
    say("unknown", line, "stderr");
    if (guess) io.stderr.write(`Did you mean ${guess}?\n`);
  };

  await showHome();
  await refreshProject();

  let lastInterrupt = -Infinity;
  try {
    for (;;) {
      rl.setPrompt(visuals.formatPrompt({ projectName }, options()));
      if (inbox.length === 0) rl.prompt();
      const read = await take();
      if (read.kind === "eof") {
        io.stdout.write("\n");
        say("bye");
        return 0;
      }
      if (read.kind === "interrupt") {
        io.stdout.write("\n");
        if (read.text.trim() !== "") {
          lastInterrupt = -Infinity;
          continue;
        }
        const now = deps.now();
        if (now - lastInterrupt < DOUBLE_INTERRUPT_MS) {
          say("bye");
          return 0;
        }
        lastInterrupt = now;
        say("interrupt");
        continue;
      }
      lastInterrupt = -Infinity;

      const line = read.text.trim();
      if (line === "") continue;
      let words = splitLine(line, io.platform);
      if (words[0] === COMMAND) words = words.slice(1);
      const first = words[0];
      if (first === undefined) continue;

      if (first === "exit" || first === "quit") {
        say("bye");
        return 0;
      }
      history = pushHistory(history, line);
      await saveHistory(file, history);
      if (first === "clear" || first === "cls") io.stdout.write("\x1b[2J\x1b[3J\x1b[H");
      else if (first === "home") await showHome();
      else if (first === "cd") await changeFolder(words);
      else if (!first.startsWith("-") && !findCommand(commands, first)) unknown(first, line);
      else {
        await dispatch(words);
        if (CHANGES_EXTENSIONS.has(first)) valueKeys = null;
        await refreshProject();
      }
    }
  } finally {
    rl.close();
    await engines.close();
  }
}
