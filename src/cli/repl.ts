// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The prompt: `safelight` with no arguments on a terminal. It reads a line in
// its own editor, runs it through main() as if it had followed `safelight` in
// a shell, and asks again. Each command opens and closes its own sessions, so
// the project lock is never held while the prompt waits. The photos `open`
// holds are the prompt's own state, handed to each command as its working set.

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { findCommand } from "./args";
import { gpuItem, guiLooksRunning } from "./commands/doctor";
import { findOpenSet, openCommand } from "./commands/open";
import { viewCommand, viewTarget } from "./commands/view";
import { DEFAULT_FACTORIES, type ServiceFactories } from "./context";
import { createEngineClient, createEngineSession, type EngineClient } from "./engine-client";
import { cliEnv } from "./env";
import { installedManifests } from "./extensions";
import { splitLine } from "./line-split";
import type { ViewTarget } from "./live/model";
import { createPromptView } from "./live/prompt";
import { main, type MainIO } from "./main";
import { readSharedSettings } from "./mirror";
import { createOutput, formatReplNote, resolveOutputOptions, showHome } from "./output";
import { probeTheme } from "./output/capabilities";
import { renderPromptArea } from "./output/prompt-render";
import type { HomeStatus, OutputOptions, OutputStreams, ReplNoteKind } from "./output/types";
import { createProjectService } from "./project";
import { createPreviewService } from "./preview";
import { createPreviewCache, type PreviewCache } from "./preview-cache";
import { createPromptData, type PromptSources } from "./prompt/data";
import { drain, emptyEditor, finalView, reduce, refreshMenu, viewOf } from "./prompt/editor";
import { fixLine } from "./prompt/ghost";
import { BUILTIN_SPECS } from "./prompt/grammar";
import type { Key } from "./prompt/keys";
import { createPrefetcher, PICTURE_COLUMNS, prefetchPreview } from "./prompt/prefetch";
import { showWhileRunning, type RunningFooter } from "./prompt/running";
import { FILE_SOURCES, guiHoldsLock, installHost } from "./prompt/sources";
import { createTerminal } from "./prompt/terminal";
import type { FooterView, PromptFrame, PromptView } from "./prompt/view";
import { holdsFolder, stepSet, withoutPhotos, workingInfo } from "./prompt/working";
import { isEdited } from "./select";
import { closest } from "./suggest";
import { type CliEnv, type CommandContext, type CommandSpec, type ExitCode, type ParsedArgs, type WorkingSet, COMMAND } from "./types";

export const HISTORY_LIMIT = 1000;
const DOUBLE_INTERRUPT_MS = 2000;
/** A command that ran this long leaves a "done" footer on the next empty line, for DONE_FOR_MS. */
const DONE_AFTER_MS = 1000;
const DONE_FOR_MS = 3000;

/** Verbs after which the extension names and value keys may have changed. */
const CHANGES_EXTENSIONS = new Set(["install", "uninstall", "enable", "disable", "update"]);

export interface ReplVisuals {
  /** Writes home; `warm` lets the bulb warm up, and aborting `skip` jumps to its last frame. */
  showHome(status: HomeStatus, streams: OutputStreams, opts: OutputOptions, warm: boolean, skip?: AbortSignal): Promise<void>;
  formatReplNote(kind: ReplNoteKind, opts: OutputOptions, text?: string): string;
  renderPromptArea(view: PromptView, opts: OutputOptions): PromptFrame;
}

/** What the prompt looks up; tests swap these for fakes. */
export interface ReplDeps {
  visuals: ReplVisuals;
  status(env: CliEnv): Promise<HomeStatus>;
  /** The project name, photos, values and folders the editor reads, in the background. */
  sources: PromptSources;
  /** Asks the terminal what it looks like before the prompt takes the keyboard; resolves with anything typed meanwhile. */
  probe(io: MainIO): Promise<string>;
  /** Calls `restore` if the process exits while the prompt holds the terminal; returns the unsubscribe. */
  onExit(restore: () => void): () => void;
  chdir(dir: string): void;
  isDirectory(dir: string): Promise<boolean>;
  now(): number;
  /** The set `open` names, found as a command finds its photos. */
  findOpenSet(ctx: CommandContext, args: ParsedArgs): Promise<WorkingSet>;
  /** Renders the open photo at `abs` in the background into `cache`; see prompt/prefetch.ts. */
  prefetch(env: CliEnv, abs: string, engine: EngineClient, signal: AbortSignal, cache: PreviewCache): Promise<string | null>;
}

/** How the prompt starts: `safelight open …` hands over its words to open before the first line. */
export interface ReplStart { open?: string[] }

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
    let picks = 0;
    try {
      const session = await projects.openRead(ref);
      try {
        const all = session.photos();
        photos = all.length;
        picks = all.filter((p) => p.flag === "pick").length;
        edited = (await Promise.all(all.map((p) => session.edit(p.id)))).filter(isEdited).length;
      } finally {
        await session.close();
      }
    } catch {
      // A catalogue that won't open is still a project; the counts stay 0.
    }
    project = { root: ref.root, name: path.basename(ref.root) || ref.root, photos, edited, picks };
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

const isDirectory = (dir: string): Promise<boolean> => stat(dir).then((s) => s.isDirectory(), () => false);

export const DEFAULT_REPL_DEPS: ReplDeps = {
  visuals: { showHome, formatReplNote, renderPromptArea: (view, opts) => renderPromptArea(view, opts) },
  status: homeStatus,
  sources: FILE_SOURCES,
  probe: async (io) => (await probeTheme(io.stdin, io.stdout, io.env)).pending,
  onExit(restore) {
    process.on("exit", restore);
    return () => { process.off("exit", restore); };
  },
  chdir: (dir) => process.chdir(dir),
  isDirectory,
  now: () => Date.now(),
  findOpenSet,
  prefetch: prefetchPreview,
};

/** `commands` with `spec` in place of the verb of the same name, or added. */
function withVerb(commands: readonly CommandSpec[], spec: CommandSpec): CommandSpec[] {
  return commands.some((c) => c.verb === spec.verb) ? commands.map((c) => (c.verb === spec.verb ? spec : c)) : [...commands, spec];
}

const photoCount = (n: number): string => (n === 1 ? "1 photo" : `${n} photos`);

// ---- the loop ----------------------------------------------------------------

/** A line, and whether it is already on screen (typed at the prompt) or still to be shown (typed ahead, pasted). */
type Read = { kind: "line"; text: string; shown: boolean } | { kind: "interrupt"; text: string } | { kind: "eof" };

const isCtrl = (key: Key, name: string): boolean => key.kind === "key" && key.ctrl && !key.alt && key.name === name;

export async function runRepl(io: MainIO, overrides: Partial<ReplDeps> = {}, start: ReplStart = {}): Promise<ExitCode> {
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
  // The prompt knows `open` whether or not the verbs list has it, and the installed extensions' verbs.
  const verbsNow = async (): Promise<CommandSpec[]> => {
    const index = await import("./commands");
    return withVerb(io.commands ?? index.withExtensionVerbs(index.COMMANDS, baseEnv.userData), openCommand);
  };
  const commands = await verbsNow();

  const engines = createEngineSession((out) => createEngineClient(envNow(), out));
  const previews = createPreviewCache();
  const services: Partial<ServiceFactories> = {
    preview: (env, out, engine, resolveTry) => createPreviewService(env, out, engine, resolveTry, undefined, previews),
    ...io.services,
    engine: (_env, out) => engines.client(out),
  };

  const say = (kind: ReplNoteKind, text?: string, stream: "stdout" | "stderr" = "stdout"): void => {
    io[stream].write(`${visuals.formatReplNote(kind, options(), text)}\n`);
  };
  const fail = (message: string, hint?: string): void => createOutput(streams, options()).error(hint === undefined ? { message } : { message, hint });
  const note = (text: string): void => createOutput(streams, options()).print(text);

  const file = historyFile(baseEnv.userData);
  let history = await loadHistory(file);

  // The open photos, and what the editor offers from the last command: its error's fix, the folder `ls` listed.
  let working: WorkingSet | null = null;
  let picture = true;
  let fix: string | null = null;
  let listed: string | null = null;
  let done: { footer: FooterView; until: number } | null = null;
  let live: RunningFooter | null = null;
  const prefetcher = createPrefetcher();

  // Lines that arrive while a command runs wait in `inbox`; a command's question takes the next one.
  const inbox: Read[] = [];
  let waiting: ((item: Read) => void) | null = null;
  let closed = false;
  let running = false;
  let cancelRunning: (() => void) | null = null;
  let stopAsked = false;

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

  // "edit": the prompt is on screen and keys repaint it. "busy": a command runs; keys are
  // typed ahead unseen. "answer": a command asked a question and the answer is echoed as typed.
  let mode: "busy" | "edit" | "answer" = "busy";
  let editor = emptyEditor();
  let answer = "";

  const data = createPromptData(
    {
      env: envNow, commands, builtins: BUILTIN_SPECS, history: () => history, sources: deps.sources,
      working: () => working, fix: () => fix, listed: () => listed,
    },
    () => {
      if (mode !== "edit") return;
      editor = refreshMenu(editor, data.context());
      paint();
    },
  );

  // Ctrl+C on a running command cancels it, the lines pasted after it and what was typed ahead.
  const stopRunning = (): void => {
    if (!running) return;
    inbox.length = 0;
    editor = emptyEditor();
    // Before the command listens, the stop waits for it.
    if (cancelRunning) cancelRunning();
    else stopAsked = true;
    // A command waiting on an answer stops waiting.
    if (waiting) deliver({ kind: "interrupt", text: "" });
  };

  const paint = (): void => {
    const view = viewOf(editor, data.context());
    const finished = done !== null && editor.line === "" && deps.now() < done.until ? done.footer : null;
    terminal.paint(visuals.renderPromptArea(finished ? { ...view, footer: finished } : view, options()));
  };
  /** Leaves `line` in scrollback in colour, without its footer, and moves below it. */
  const record = (line: string): void => {
    const frame = visuals.renderPromptArea(finalView(line, data.context()), options());
    terminal.commit(frame.rows.slice(0, frame.cursorRow + 1));
  };

  const answerKey = (key: Key): void => {
    const finish = (text: string): void => {
      io.stderr.write("\r\n");
      answer = "";
      mode = "busy";
      deliver({ kind: "line", text, shown: true });
    };
    if (key.kind !== "key") {
      const [first, ...rest] = key.text.split(/\r?\n|\r/);
      const typed = first.replace(/[\x00-\x1f\x7f]/g, "");
      answer += typed;
      io.stderr.write(typed);
      if (rest.length > 0) finish(answer);
      return;
    }
    if (key.name === "enter" || isCtrl(key, "d")) finish(answer);
    else if (isCtrl(key, "c")) {
      io.stderr.write("\r\n");
      answer = "";
      mode = "busy";
      stopRunning();
    } else if (key.name === "backspace" && answer !== "") {
      answer = [...answer].slice(0, -1).join("");
      io.stderr.write("\b \b");
    }
  };

  let warming: AbortController | null = null;

  const onKeys = (keys: Key[]): void => {
    // A key during the bulb's warm-up skips it, and is typed into the prompt.
    warming?.abort();
    for (const [i, key] of keys.entries()) {
      if (mode === "answer") {
        answerKey(key);
        continue;
      }
      if (mode === "busy" && isCtrl(key, "c")) {
        stopRunning();
        continue;
      }
      // More keys in the same read after an enter means a paste: it runs as typed, no pickers.
      editor = reduce(editor, key, data.context(), { interactive: mode === "edit" && i === keys.length - 1 });
      const [events, rest] = drain(editor);
      editor = rest;
      for (const event of events) {
        switch (event.kind) {
          case "submit":
            if (mode === "edit") record(event.line);
            deliver({ kind: "line", text: event.line, shown: mode === "edit" });
            mode = "busy";
            break;
          case "interrupt":
            if (mode === "edit") record(event.line);
            mode = "busy";
            deliver({ kind: "interrupt", text: event.line });
            break;
          case "eof":
            if (mode === "edit") record("");
            mode = "busy";
            deliver({ kind: "eof" });
            break;
          case "clear-screen":
            terminal.clearScreen();
            break;
        }
      }
    }
    if (mode === "edit") paint();
  };

  const terminal = createTerminal({ stdin: io.stdin, stdout: io.stdout }, {
    onKeys,
    onResize: () => { if (mode === "edit") paint(); },
    onExit: deps.onExit,
  });
  const onEnd = (): void => {
    closed = true;
    if (waiting) deliver({ kind: "eof" });
  };
  io.stdin.once("end", onEnd);

  const ask = async (question: string): Promise<string> => {
    io.stderr.write(question);
    if (inbox.length > 0 || closed) {
      const queued = await take();
      const text = queued.kind === "line" ? queued.text : "";
      io.stderr.write(`${text}\n`);
      return text;
    }
    answer = editor.line;
    editor = emptyEditor();
    io.stderr.write(answer);
    mode = "answer";
    const reply = await take();
    if (mode === "answer") mode = "busy";
    return reply.kind === "line" ? reply.text : "";
  };

  const showHome = async (warm: boolean): Promise<void> => {
    const status = await deps.status(envNow());
    warming = new AbortController();
    try {
      await visuals.showHome(status, streams, options(), warm, warming.signal);
    } finally {
      warming = null;
    }
  };

  /** The footer row alone, as the prompt would draw it under an empty line. */
  const footerRow = (footer: FooterView): string => {
    const frame = visuals.renderPromptArea({ ...finalView("", data.context()), footer }, options());
    return frame.rows[frame.rows.length - 1] ?? "";
  };

  /** Runs `words` through main; `own` stands in for the verb of the same name. */
  const dispatch = async (words: string[], own?: CommandSpec): Promise<ExitCode> => {
    const stopListening = io.onInterrupt(stopRunning);
    running = true;
    stopAsked = false;
    const verb = words.find((w) => !w.startsWith("-")) ?? COMMAND;
    const startedAt = deps.now();
    const clock = Date.now();
    live = showWhileRunning(streams, () => footerRow({ kind: "running", label: `Running ${verb}`, startedAt: clock }));
    let code: ExitCode = 1;
    try {
      // The engine answers one request at a time: what was asked goes before the prefetch.
      await prefetcher.stop();
      code = await main(words, {
        ...io,
        cwd,
        commands: own ? withVerb(commands, own) : commands,
        services,
        quietStop: true,
        ask,
        atPrompt: true,
        ...(working && { working }),
        onProblem: (problem) => { fix = fixLine(problem); },
        onInterrupt(handler) {
          cancelRunning = handler;
          if (stopAsked) {
            stopAsked = false;
            handler();
          }
          return () => { cancelRunning = null; };
        },
      });
    } finally {
      live.stop();
      live = null;
      running = false;
      stopAsked = false;
      stopListening();
    }
    if (code === 130) {
      inbox.length = 0;
      // The engine may still be on the stopped command's job.
      await engines.close();
      say("cancelled");
    } else if (deps.now() - startedAt >= DONE_AFTER_MS) {
      const seconds = ((deps.now() - startedAt) / 1000).toFixed(1);
      const message = code === 0 ? `${verb} finished in ${seconds} s` : `${verb} ended with exit ${code} after ${seconds} s`;
      done = { footer: { kind: "done", message, ok: code === 0 }, until: deps.now() + DONE_FOR_MS };
      setTimeout(() => { if (mode === "edit") paint(); }, DONE_FOR_MS).unref?.();
    }
    return code;
  };

  // ---- the open photos ---------------------------------------------------------

  const quietOutput = () => createOutput(streams, resolveOutputOptions(streams, io.env, "quiet"));

  const liveView = createPromptView({
    env: envNow,
    out: () => createOutput(streams, options()),
    engine: () => engines.client(quietOutput()),
    projects: () => (io.services?.projects ?? DEFAULT_FACTORIES.projects)(envNow(), installHost(envNow())),
    values: () => (io.services?.values ?? DEFAULT_FACTORIES.values)(envNow()),
    working: () => working,
    async step(by) {
      const step = working && stepSet(working, by);
      if (!step || step.moved === 0) return false;
      working = step.set;
      data.touch();
      if (mode === "edit") paint();
      return true;
    },
    around(draw) {
      if (running) return false;
      if (mode !== "edit") draw();
      else {
        terminal.erase();
        draw();
        paint();
      }
      return true;
    },
    async resolve(words) {
      const found: { target: ViewTarget | null } = { target: null };
      const own: CommandSpec = { ...viewCommand, async run(ctx, args) { found.target = await viewTarget(ctx, args); return { code: 0 }; } };
      return (await dispatch(words, own)) === 0 ? found.target : null;
    },
  });

  /** Renders the photo `by` places on from the current one, in the background, if there is one. */
  const prefetchFrom = (by: 1 | -1): void => {
    if (!working || !picture) return;
    const target = working.paths[working.index + by];
    if (target === undefined) return;
    prefetcher.start((signal) => deps.prefetch(envNow(), target, engines.client(quietOutput()), signal, previews));
  };

  /** The current photo as the prompt shows it: its values, then its picture. */
  const showCurrent = async (by: 1 | -1 = 1): Promise<void> => {
    if (!working) return;
    data.touch();
    const code = await dispatch(["tools", "@"]);
    if (code === 0 && picture) await dispatch(["preview", "@", "--width", String(PICTURE_COLUMNS)]);
    // The empty line's footer is the photo now on screen, not how long showing it took.
    done = null;
    prefetchFrom(by);
  };

  const closeSet = (why = ""): void => {
    if (!working) return;
    note(`Closed ${photoCount(working.paths.length)}${why}.`);
    working = null;
    void prefetcher.stop();
    data.touch();
  };

  /** Photos removed meanwhile, by Safelight or `forget`, leave the set. */
  const dropGone = (): void => {
    const { index, root } = data.context();
    // The prompt knows the catalogue of the project it is in, so only a set from that one is judged.
    const p = io.platform === "win32" ? path.win32 : path.posix;
    if (!working || !index || !root || p.relative(root, working.root) !== "") return;
    const { rels } = workingInfo(working, cwd, io.platform);
    const gone = new Set(working.paths.filter((_abs, i) => !index.find(rels[i])));
    if (gone.size === 0) return;
    for (const abs of gone) note(`${path.basename(abs)} isn't in the catalogue any more, so it left the open photos.`);
    working = withoutPhotos(working, (abs) => gone.has(abs));
    data.touch();
  };

  const listSet = (set: WorkingSet): void => {
    const mark = options().unicode ? "›" : ">";
    const { rels } = workingInfo(set, cwd, io.platform);
    note(rels.map((rel, i) => `${i === set.index ? mark : " "} ${rel}`).join("\n"));
  };

  const openPhotos = async (words: string[]): Promise<void> => {
    if (words.length <= 1 && working) {
      listSet(working);
      return;
    }
    const found: { set: WorkingSet | null } = { set: null };
    const own: CommandSpec = {
      ...openCommand,
      async run(ctx, args) {
        found.set = await deps.findOpenSet(ctx, args);
        return { code: 0 };
      },
    };
    if ((await dispatch(words, own)) !== 0 || !found.set) return;
    working = found.set;
    picture = !words.includes("--no-preview");
    if (working.paths.length > 1) note(`Opened ${photoCount(working.paths.length)}.`);
    await showCurrent();
  };

  const move = async (words: string[]): Promise<void> => {
    const by = words[1] === undefined ? 1 : Number(words[1]);
    if (!Number.isInteger(by) || by < 1) {
      fail(`${words[1]} isn't a number of photos.`, `${words[0]} 5 moves five photos.`);
      return;
    }
    if (!working) {
      fail("No photo is open.", "open <photo> opens one.");
      return;
    }
    const forward = words[0] === "next";
    const step = stepSet(working, forward ? by : -by);
    if (step.moved === 0) {
      note(forward ? "That's the last open photo." : "That's the first open photo.");
      return;
    }
    working = step.set;
    await showCurrent(forward ? 1 : -1);
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
    listed = null;
    if (working && !holdsFolder(working, target, io.platform)) closeSet(` in ${path.basename(working.root) || working.root}`);
    await data.refresh();
  };

  /** The folder an `ls` line listed, from the prompt's folder, "/"-separated. */
  const listedFolder = (args: string[]): string => {
    const named = args.find((arg) => !arg.startsWith("-"));
    if (named === undefined) return "";
    const p = io.platform === "win32" ? path.win32 : path.posix;
    const rel = p.relative(cwd, p.resolve(cwd, named));
    return io.platform === "win32" ? rel.replace(/\\/g, "/") : rel;
  };

  const unknown = (word: string, line: string): void => {
    const names = [...commands.flatMap((c) => [c.verb, ...(c.aliases ?? [])]), ...BUILTIN_SPECS.flatMap((b) => [b.verb, ...(b.aliases ?? [])])];
    const guess = closest(word, names);
    say("unknown", line, "stderr");
    if (guess) io.stderr.write(`Did you mean ${guess}?\n`);
  };

  const typedEarly = await deps.probe(io);
  if (typedEarly !== "") io.stdin.unshift(typedEarly);
  terminal.start();
  // `safelight open X` lands on X, as `vim file` does, without the home screen.
  if (start.open) {
    await data.refresh();
    await openPhotos(start.open);
  } else await showHome(true);
  await data.refresh();

  let lastInterrupt = -Infinity;
  try {
    for (;;) {
      let read: Read;
      if (inbox.length === 0 && !closed) {
        mode = "edit";
        paint();
        read = await take();
      } else {
        read = await take();
        if (read.kind === "line" && !read.shown) record(read.text);
      }
      mode = "busy";
      if (read.kind === "eof") {
        say("bye");
        return 0;
      }
      if (read.kind === "interrupt") {
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
      fix = null;
      done = null;
      dropGone();
      data.touch();
      await saveHistory(file, history);
      if (first === "clear" || first === "cls") terminal.clearScreen();
      else if (first === "home") await showHome(false);
      else if (first === "cd") await changeFolder(words);
      else if (first === "next" || first === "prev") await move(words);
      else if (first === "close") {
        if (working) closeSet();
        else note("No photo is open.");
      } else if (first === "open") {
        await openPhotos(words);
        await data.refresh();
      } else if (first === "view") await liveView.command(words);
      else if (!first.startsWith("-") && !findCommand(commands, first)) unknown(first, line);
      else {
        const code = await dispatch(words);
        if (CHANGES_EXTENSIONS.has(first)) {
          commands.splice(0, commands.length, ...(await verbsNow()));
          data.reloadValues();
        }
        if (first === "ls" && code === 0) listed = listedFolder(words.slice(1));
        await data.refresh();
      }
      if (first !== "view") await liveView.after(first);
    }
  } finally {
    terminal.stop();
    io.stdin.off("end", onEnd);
    await liveView.stop();
    await prefetcher.stop();
    await engines.close();
  }
}
