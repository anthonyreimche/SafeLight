// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// `safelight`: Safelight Unplugged. Finds the verb, applies the global options, runs
// the verb and turns what it throws into a message and an exit code.

import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { findCommand, parseArgs } from "./args";
import { DEFAULT_FACTORIES, createContext, type ServiceFactories } from "./context";
import { cliEnv } from "./env";
import { installNodeHost } from "./host";
import { readSharedSettings } from "./mirror";
import { createNodeFsBridge } from "./node-fs";
import { createOutput, resolveOutputOptions, settleOutput } from "./output";
import type { Output, Problem } from "./output/types";
import { closest } from "./suggest";
import { CliError, type CommandSpec, type ExitCode, type ParsedArgs, type Verbosity, type WorkingSet, COMMAND } from "./types";

export interface MainIO {
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  platform: NodeJS.Platform;
  home: string;
  /** The running bundle, to find the app beside it. */
  moduleFile: string;
  /** Running inside Electron's binary as plain Node (the launcher's fallback). */
  underElectron?: boolean;
  /** Calls `handler` on Ctrl+C; returns the unsubscribe. */
  onInterrupt(handler: () => void): () => void;
  /** Tests swap the verbs or services; the bin entry uses the real ones. */
  commands?: readonly CommandSpec[];
  services?: Partial<ServiceFactories>;
  /** The prompt says what happened to a stopped command itself. */
  quietStop?: boolean;
  /** The prompt answers a command's questions from its own lines. */
  ask?: (question: string) => Promise<string>;
  /** Set by the prompt for the lines it runs, so `open` doesn't start another prompt. */
  atPrompt?: boolean;
  /** The photos the prompt has open. */
  working?: WorkingSet;
  /** Told the error a command ends with, so the prompt can offer its fix. */
  onProblem?: (problem: Problem) => void;
}

function verbosityOf(options: ParsedArgs["options"]): Verbosity {
  if (options.quiet === true) return "quiet";
  if (options.verbose === 2) return "debug";
  if (options.verbose === 1) return "verbose";
  return "normal";
}

function waitSecondsOf(options: ParsedArgs["options"]): number | null {
  const wait = options.wait;
  if (wait === undefined) return null;
  if (wait === true) return Infinity;
  const seconds = Number(wait);
  if (typeof wait !== "string" || wait.trim() === "" || !(seconds >= 0)) {
    throw new CliError(1, `--wait needs seconds, not "${String(wait)}".`, "Add --wait to wait as long as it takes.");
  }
  return seconds;
}

function unknownVerb(word: string, commands: readonly CommandSpec[]): CliError {
  const names = commands.flatMap((c) => [c.verb, ...(c.aliases ?? [])]);
  const guess = closest(word, names);
  const message = guess ? `"${word}" isn't a ${COMMAND} verb. Did you mean ${guess}?` : `"${word}" isn't a ${COMMAND} verb.`;
  return new CliError(1, message, `${COMMAND} help lists them.`);
}

function report(error: unknown, out: Output, json: boolean, onProblem?: (problem: Problem) => void): ExitCode {
  const failure = error instanceof CliError
    ? error
    : new CliError(1, error instanceof Error ? error.message : String(error));
  const problem: Problem = {
    message: failure.message,
    ...(failure.hint !== undefined && { hint: failure.hint }),
    ...(failure.fix !== undefined && { fix: failure.fix }),
  };
  out.error(problem);
  onProblem?.(problem);
  if (json) out.json({ slu: 1, ok: false, error: { code: failure.code, ...problem } });
  return failure.code;
}

export async function main(argv: string[], io: MainIO): Promise<ExitCode> {
  if (argv.length === 0 && io.stdin.isTTY === true && io.stdout.isTTY === true) {
    const { runRepl } = await import("./repl");
    return runRepl(io);
  }
  const streams = { stdout: io.stdout, stderr: io.stderr };
  const outputFor = (verbosity: Verbosity) => createOutput(streams, resolveOutputOptions(streams, io.env, verbosity));

  const dashDash = argv.indexOf("--");
  let json = (dashDash < 0 ? argv : argv.slice(0, dashDash)).includes("--json");
  let out = outputFor("normal");

  try {
    const env = cliEnv({
      cwd: io.cwd,
      env: io.env,
      platform: io.platform,
      home: io.home,
      isTTY: { stdin: io.stdin.isTTY === true, stdout: io.stdout.isTTY === true, stderr: io.stderr.isTTY === true },
      moduleFile: io.moduleFile,
    });
    // Core modules read window and localStorage, so the shims go in before the verbs load them.
    const bridge = createNodeFsBridge(env.userData);
    installNodeHost({ bridge, platform: env.platform, storage: readSharedSettings(env.userData)?.storage ?? {} });
    const index = io.commands ? null : await import("./commands");
    const commands: readonly CommandSpec[] = io.commands ?? index?.withExtensionVerbs(index.COMMANDS, env.userData) ?? [];

    const first = parseArgs(argv, null, (word) => findCommand(commands, word)?.rawArgs === true);
    json = first.options.json === true;
    out = outputFor(verbosityOf(first.options));

    let spec: CommandSpec | null;
    if (first.verb === null) {
      if (argv.length === 0 && io.underElectron === true && io.platform === "win32") {
        out.warn({ message: "The interactive prompt needs Node 22 or newer on PATH." });
      }
      spec = findCommand(commands, first.options.version === true ? "version" : "help");
    } else {
      spec = findCommand(commands, first.verb);
      if (!spec) throw (await import("./commands/open")).promptOnlyError(first.verb) ?? unknownVerb(first.verb, commands);
    }
    if (!spec) throw unknownVerb(first.verb ?? "help", commands);

    let args = parseArgs(argv, spec);
    json = args.options.json === true;
    const verbosity = verbosityOf(args.options);
    out = outputFor(verbosity);

    // --help and --version on any verb mean the help or version verb.
    const redirect = args.options.help === true && spec.verb !== "help" ? "help"
      : args.options.version === true && spec.verb !== "version" ? "version"
      : null;
    if (redirect) {
      const target = findCommand(commands, redirect);
      if (!target) throw unknownVerb(redirect, commands);
      args = { ...args, verb: target.verb, positionals: redirect === "help" ? [spec.verb] : [], assignments: [] };
      spec = target;
    }

    // `safelight open X` is the prompt with X open (D-L3); without a terminal, the verb refuses.
    if (spec.verb === "open" && io.atPrompt !== true && !json && env.isTTY.stdin && env.isTTY.stdout) {
      const { runRepl } = await import("./repl");
      return await runRepl(io, {}, { open: argv });
    }

    const stopping = new AbortController();
    const forcing = new AbortController();
    const ctx = createContext(
      {
        env,
        out,
        json,
        verbosity,
        strict: args.options.strict === true,
        yes: args.options.yes === true,
        waitSeconds: waitSecondsOf(args.options),
        stdin: io.stdin,
        ask: io.ask,
        bridge,
        working: io.working,
        stops: { signal: stopping.signal, force: forcing.signal },
      },
      { ...DEFAULT_FACTORIES, ...io.services },
    );

    // A command that owns its stop winds down on the first Ctrl+C; anything else, and a second Ctrl+C, stops here.
    const ownsStop = spec.ownsStop === true;
    let stopInterrupt = () => {};
    const interrupted = new Promise<null>((resolve) => {
      stopInterrupt = io.onInterrupt(() => {
        const first = !stopping.signal.aborted;
        stopping.abort();
        if (ownsStop && first) return;
        forcing.abort();
        resolve(null);
      });
    });
    try {
      const outcome = await Promise.race([spec.run(ctx, args), interrupted]);
      if (outcome === null) {
        // What was stored is written whole and the locks are given back; the rest is dropped.
        await ctx.dispose();
        if (io.quietStop !== true) out.error({ message: "Stopped." });
        return 130;
      }
      if (json && outcome.json !== undefined) out.json(outcome.json);
      return outcome.code;
    } finally {
      stopInterrupt();
      await settleOutput();
    }
  } catch (error) {
    return report(error, out, json, io.onProblem);
  }
}

/** The real process, for the bin entry. */
export function processIO(moduleFile: string): MainIO {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    env: process.env,
    cwd: process.cwd(),
    platform: process.platform,
    home: homedir(),
    moduleFile,
    underElectron: process.versions.electron !== undefined,
    onInterrupt(handler) {
      process.on("SIGINT", handler);
      return () => process.off("SIGINT", handler);
    },
  };
}

function flushed(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => stream.write("", () => resolve()));
}

// Defined only by vite.cli.config.ts, so importing this module (tests) runs nothing.
declare const __SLU_BIN__: boolean | undefined;
if (typeof __SLU_BIN__ !== "undefined" && __SLU_BIN__) {
  const code = await main(process.argv.slice(2), processIO(fileURLToPath(import.meta.url)));
  await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
  process.exit(code);
}
