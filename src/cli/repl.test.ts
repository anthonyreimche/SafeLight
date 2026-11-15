import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main, type MainIO } from "./main";
import type { HomeStatus } from "./output/types";
import { HISTORY_LIMIT, loadHistory, pushHistory, runRepl, type ReplDeps } from "./repl";
import type { CommandSpec } from "./types";

const HERE = import.meta.dirname;
const CTRL_C = "\x03";
const CTRL_D = "\x04";
const UP = "\x1b[A";

let userData: string;
beforeEach(() => { userData = mkdtempSync(join(tmpdir(), "slu-repl-")); });
afterEach(() => { rmSync(userData, { recursive: true, force: true }); });

function verb(name: string, run: CommandSpec["run"]): CommandSpec {
  return { verb: name, group: "More", summary: "", usage: name, examples: [], options: [], writes: false, run };
}

function makeCommands(seen: { cwd: string; args: string[] }[] = []): CommandSpec[] {
  return [
    verb("echo", async (ctx, args) => {
      seen.push({ cwd: ctx.env.cwd, args: [...args.positionals, ...args.assignments.map((a) => a.raw)] });
      ctx.out.print(`echo:${[...args.positionals, ...args.assignments.map((a) => a.raw)].join("|")}`);
      return { code: 0, json: { slu: 1, echoed: args.positionals } };
    }),
    verb("ask", async (ctx) => { ctx.out.print(`answer:${await ctx.ask?.("Sure? ")}`); return { code: 0 }; }),
    verb("hang", () => new Promise(() => {})),
    verb("help", async (ctx) => { ctx.out.print("HELP"); return { code: 0 }; }),
  ];
}

function harness(opts: { commands?: CommandSpec[]; deps?: Partial<ReplDeps>; tty?: boolean; cwd?: string; start?: boolean } = {}) {
  const tty = opts.tty ?? true;
  const stdin = Object.assign(new PassThrough(), { isTTY: tty, setRawMode: () => stdin }) as unknown as NodeJS.ReadStream;
  const chunks: string[] = [];
  const errChunks: string[] = [];
  const mk = () => Object.assign(new PassThrough(), { isTTY: tty, columns: 80 }) as unknown as NodeJS.WriteStream & PassThrough;
  const stdout = mk();
  const stderr = mk();
  stdout.on("data", (c: Buffer) => chunks.push(c.toString()));
  stderr.on("data", (c: Buffer) => errChunks.push(c.toString()));
  let interrupt: (() => void) | null = null;
  const io: MainIO = {
    stdout, stderr, stdin,
    env: { SLU_USER_DATA: userData },
    cwd: opts.cwd ?? HERE,
    platform: process.platform,
    home: HERE,
    moduleFile: join(HERE, "main.ts"),
    onInterrupt: (handler) => { interrupt = handler; return () => { interrupt = null; }; },
    commands: opts.commands ?? makeCommands(),
  };

  let prompts = 0;
  const names: (string | null)[] = [];
  const status: HomeStatus = {
    version: "9.9.9", cwd: HERE, project: null, guiHasProjectOpen: false, graphics: null,
    settingsShared: false, extensions: { installed: 0, updates: null },
  };
  const deps: Partial<ReplDeps> = {
    visuals: {
      formatHome: () => "HOME-SCREEN\n",
      formatPrompt: (state) => { prompts++; names.push(state.projectName); return `${state.projectName ?? "-"}> `; },
      formatReplNote: (kind, _o, text) => `[${kind}${text === undefined ? "" : `:${text}`}]`,
    },
    status: async () => status,
    projectName: async (env) => env.cwd.split(/[\\/]/).pop() ?? null,
    chdir: () => {},
    isDirectory: async () => true,
    ...opts.deps,
  };

  const until = async (check: () => boolean): Promise<void> => {
    for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
    if (!check()) throw new Error(`timed out; stdout so far: ${JSON.stringify(chunks.join(""))}`);
  };
  const result = opts.start === false ? Promise.resolve(0 as const) : runRepl(io, deps);
  return {
    io, names, result,
    out: () => chunks.join(""),
    err: () => errChunks.join(""),
    prompt: (n: number) => until(() => prompts >= n),
    send: (text: string) => stdin.push(text),
    interrupt: () => interrupt?.(),
    until,
  };
}

describe("history helpers", () => {
  it("skips a line equal to the previous one and keeps the newest 1000", () => {
    expect(pushHistory(["a", "b"], "b")).toEqual(["a", "b"]);
    expect(pushHistory(["a", "b"], "a")).toEqual(["a", "b", "a"]);
    const many = Array.from({ length: HISTORY_LIMIT }, (_, i) => `l${i}`);
    const next = pushHistory(many, "new");
    expect(next).toHaveLength(HISTORY_LIMIT);
    expect(next[0]).toBe("l1");
    expect(next[next.length - 1]).toBe("new");
  });

  it("loads the file, deduplicating and capping", async () => {
    const file = join(userData, "h");
    writeFileSync(file, ["a", "a", "b", "", "c"].join("\n"));
    expect(await loadHistory(file)).toEqual(["a", "b", "c"]);
    expect(await loadHistory(file, 2)).toEqual(["b", "c"]);
    expect(await loadHistory(join(userData, "missing"))).toEqual([]);
  });
});

describe("prompt", () => {
  it("prints the home screen, then leaves on exit", async () => {
    const h = harness();
    await h.prompt(1);
    expect(h.out()).toContain("HOME-SCREEN");
    h.send("exit\r");
    expect(await h.result).toBe(0);
    expect(h.out()).toContain("[bye]");
  });

  it("leaves on quit and on Ctrl+D", async () => {
    const quit = harness();
    await quit.prompt(1);
    quit.send("quit\r");
    expect(await quit.result).toBe(0);

    const eof = harness();
    await eof.prompt(1);
    eof.send(CTRL_D);
    expect(await eof.result).toBe(0);
    expect(eof.out()).toContain("[bye]");
  });

  it("runs a line through main, splitting it like a shell", async () => {
    const seen: { cwd: string; args: string[] }[] = [];
    const h = harness({ commands: makeCommands(seen) });
    await h.prompt(1);
    h.send(`echo "my photo.ARW" 'a b' C:\\x\\y.ARW exposure=+0.5\r`);
    await h.prompt(2);
    expect(seen).toEqual([{ cwd: HERE, args: ["my photo.ARW", "a b", process.platform === "win32" ? "C:\\x\\y.ARW" : "C:xy.ARW", "exposure=+0.5"] }]);
    expect(h.out()).toContain("echo:my photo.ARW|a b|");
    h.send("exit\r");
    await h.result;
  });

  it("accepts a leading safelight", async () => {
    const seen: { cwd: string; args: string[] }[] = [];
    const h = harness({ commands: makeCommands(seen) });
    await h.prompt(1);
    h.send("safelight echo one\r");
    await h.prompt(2);
    expect(seen[0].args).toEqual(["one"]);
    h.send("exit\r");
    await h.result;
  });

  it("passes --json through for the one line", async () => {
    const h = harness();
    await h.prompt(1);
    h.send("echo a --json\r");
    await h.prompt(2);
    expect(h.out()).toMatch(/"echoed": \[\s*"a"\s*\]/);
    h.send("echo b\r");
    await h.prompt(3);
    expect(h.out()).not.toMatch(/"echoed": \[\s*"b"/);
    h.send("exit\r");
    await h.result;
  });

  it("runs help through main", async () => {
    const h = harness();
    await h.prompt(1);
    h.send("help\r");
    await h.prompt(2);
    expect(h.out()).toContain("HELP");
    h.send("exit\r");
    await h.result;
  });

  it("answers an unknown first word with a note and a suggestion", async () => {
    const h = harness();
    await h.prompt(1);
    h.send("ech x\r");
    await h.prompt(2);
    expect(h.err()).toContain("[unknown:ech x]");
    expect(h.err()).toContain("Did you mean echo?");
    h.send("exit\r");
    await h.result;
  });

  it("prints home again, and clears", async () => {
    const h = harness();
    await h.prompt(1);
    h.send("home\r");
    await h.prompt(2);
    expect(h.out().split("HOME-SCREEN").length - 1).toBe(2);
    h.send("clear\r");
    await h.prompt(3);
    expect(h.out()).toContain("\x1b[2J");
    h.send("exit\r");
    await h.result;
  });

  it("cd changes the folder commands run in and the prompt's project", async () => {
    const seen: { cwd: string; args: string[] }[] = [];
    const moved: string[] = [];
    const target = join(HERE, "output");
    const h = harness({ commands: makeCommands(seen), deps: { chdir: (d) => { moved.push(d); } } });
    await h.prompt(1);
    h.send("cd output\r");
    await h.prompt(2);
    expect(moved).toEqual([target]);
    expect(h.names.at(-1)).toBe("output");
    h.send("echo x\r");
    await h.prompt(3);
    expect(seen[0].cwd).toBe(target);
    h.send("exit\r");
    await h.result;
  });

  it("cd to something that is not a folder says so and stays", async () => {
    const moved: string[] = [];
    const h = harness({ deps: { chdir: (d) => { moved.push(d); }, isDirectory: async () => false } });
    await h.prompt(1);
    h.send("cd nowhere\r");
    await h.prompt(2);
    expect(moved).toEqual([]);
    expect(h.err()).toContain("nowhere isn't a folder.");
    h.send("exit\r");
    await h.result;
  });

  it("saves lines to <userData>/slu/history without repeating one, and recalls them with the up arrow", async () => {
    mkdirSync(join(userData, "slu"));
    writeFileSync(join(userData, "slu", "history"), "echo old\n");
    const seen: { cwd: string; args: string[] }[] = [];
    const h = harness({ commands: makeCommands(seen) });
    await h.prompt(1);
    h.send(`${UP}\r`);
    await h.prompt(2);
    expect(seen[0].args).toEqual(["old"]);
    h.send("echo new\r");
    await h.prompt(3);
    h.send("echo new\r");
    await h.prompt(4);
    h.send("exit\r");
    await h.result;
    expect(readFileSync(join(userData, "slu", "history"), "utf8")).toBe("echo old\necho new\n");
  });

  it("Ctrl+C at an empty prompt says how to leave; a second within 2 s leaves", async () => {
    let now = 1000;
    const h = harness({ deps: { now: () => now } });
    await h.prompt(1);
    h.send(CTRL_C);
    await h.prompt(2);
    expect(h.out()).toContain("[interrupt]");
    now += 500;
    h.send(CTRL_C);
    expect(await h.result).toBe(0);
    expect(h.out()).toContain("[bye]");
  });

  it("Ctrl+C a while after the first does not leave", async () => {
    let now = 1000;
    const h = harness({ deps: { now: () => now } });
    await h.prompt(1);
    h.send(CTRL_C);
    await h.prompt(2);
    now += 5000;
    h.send(CTRL_C);
    await h.prompt(3);
    h.send("exit\r");
    expect(await h.result).toBe(0);
    expect(h.out().split("[interrupt]").length - 1).toBe(2);
  });

  it("Ctrl+C while a command runs cancels it and returns to the prompt", async () => {
    const h = harness();
    await h.prompt(1);
    h.send("hang\r");
    await h.until(() => h.out().includes("hang"));
    await new Promise((r) => setTimeout(r, 20));
    h.interrupt();
    await h.prompt(2);
    expect(h.out()).toContain("[cancelled]");
    expect(h.err()).not.toContain("Stopped.");
    h.send("echo ok\r");
    await h.prompt(3);
    expect(h.out()).toContain("echo:ok");
    h.send("exit\r");
    await h.result;
  });
});

describe("pasted lines", () => {
  it("runs every pasted line, in order", async () => {
    const seen: { cwd: string; args: string[] }[] = [];
    const h = harness({ commands: makeCommands(seen) });
    await h.prompt(1);
    h.send("echo a\recho b\recho c\r");
    await h.until(() => seen.length === 3);
    expect(seen.map((x) => x.args[0])).toEqual(["a", "b", "c"]);
    h.send("exit\r");
    await h.result;
  });

  it("answers a question from the next line", async () => {
    const h = harness();
    await h.prompt(1);
    h.send("ask\ry\recho after\r");
    await h.until(() => h.out().includes("echo:after"));
    expect(h.out()).toContain("answer:y");
    h.send("exit\r");
    await h.result;
  });

  it("drops the rest of a paste when its first command is cancelled", async () => {
    const seen: { cwd: string; args: string[] }[] = [];
    const h = harness({ commands: makeCommands(seen) });
    await h.prompt(1);
    h.send("hang\recho b\recho c\r");
    await h.until(() => h.out().includes("hang"));
    await new Promise((r) => setTimeout(r, 20));
    h.interrupt();
    await h.until(() => h.out().includes("[cancelled]"));
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual([]);
    h.send("echo d\r");
    await h.until(() => seen.length === 1);
    expect(seen[0].args).toEqual(["d"]);
    h.send("exit\r");
    await h.result;
  });
});

describe("no arguments", () => {
  it("starts the prompt when stdin and stdout are terminals", async () => {
    const h = harness({ start: false });
    const run = main([], h.io);
    await h.until(() => h.out().length > 0);
    h.send("exit\r");
    expect(await run).toBe(0);
    expect(h.out()).toContain(__APP_VERSION__);
  });

  it("prints help when they are not", async () => {
    const h = harness({ tty: false, start: false });
    const code = await main([], h.io);
    expect(code).toBe(0);
    expect(h.out()).toContain("HELP");
  });
});
