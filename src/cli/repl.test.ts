import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openCommand } from "./commands/open";
import { main, type MainIO } from "./main";
import type { HomeStatus } from "./output/types";
import type { PhotoFact } from "./prompt/context";
import type { PromptFrame, PromptView } from "./prompt/view";
import { HISTORY_LIMIT, loadHistory, pushHistory, runRepl, type ReplDeps, type ReplVisuals } from "./repl";
import { CliError, type CommandSpec, type WorkingSet } from "./types";

const HERE = import.meta.dirname;
const CTRL_C = "\x03";
const CTRL_D = "\x04";
const UP = "\x1b[A";
const RIGHT = "\x1b[C";

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

function harness(opts: { commands?: CommandSpec[]; deps?: Partial<ReplDeps>; tty?: boolean; cwd?: string; start?: boolean; photos?: PhotoFact[]; showHome?: ReplVisuals["showHome"] } = {}) {
  const tty = opts.tty ?? true;
  const raw: boolean[] = [];
  const stdin = Object.assign(new PassThrough(), {
    isTTY: tty,
    setRawMode: (on: boolean) => { raw.push(on); return stdin; },
  }) as unknown as NodeJS.ReadStream & PassThrough;
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

  const views: PromptView[] = [];
  const status: HomeStatus = {
    version: "9.9.9", cwd: HERE, project: null, guiHasProjectOpen: false, graphics: null,
    settingsShared: false, extensions: { installed: 0, updates: null },
  };
  const deps: Partial<ReplDeps> = {
    visuals: {
      showHome: opts.showHome ?? (async (_status, streams) => { streams.stdout.write("HOME-SCREEN\n"); }),
      formatReplNote: (kind, _o, text) => `[${kind}${text === undefined ? "" : `:${text}`}]`,
      renderPromptArea: plainRender(views),
    },
    status: async () => status,
    sources: {
      projectName: async (env) => env.cwd.split(/[\\/]/).pop() ?? null,
      photos: async () => (opts.photos ? { photos: opts.photos, look: async () => undefined } : null),
      values: () => [],
      extensionNames: () => [],
      readDir: async () => [],
    },
    probe: async () => "",
    onExit: () => () => {},
    chdir: () => {},
    isDirectory: async () => true,
    ...opts.deps,
  };

  const until = async (check: () => boolean): Promise<void> => {
    for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
    if (!check()) throw new Error(`timed out; stdout so far: ${JSON.stringify(chunks.join(""))}`);
  };
  const result = opts.start === false ? Promise.resolve(0 as const) : runRepl(io, deps);
  const count = (text: string, of: string) => of.split(text).length - 1;
  return {
    io, views, raw, result,
    out: () => chunks.join(""),
    err: () => errChunks.join(""),
    /** The prompt is up, waiting on its first line. */
    ready: () => until(() => views.length > 0),
    lastView: () => views[views.length - 1],
    send: (text: string) => stdin.push(text),
    interrupt: () => interrupt?.(),
    count,
    until,
  };
}

/** A plain stand-in for the real prompt renderer: "name> line" and the footer's kind. */
function plainRender(views: PromptView[]) {
  return (view: PromptView): PromptFrame => {
    views.push(view);
    const prefix = `${view.projectName ?? "-"}> `;
    const under = view.picker
      ? [`[${view.picker.title}]`, ...view.picker.items.map((item, i) => `${i === view.picker?.selected ? ">" : " "} ${item.label}`)]
      : view.menu ? view.menu.items.map((item) => item.label) : [`(${view.footer.kind})`];
    return { rows: [`${prefix}${view.line}${view.ghost ?? ""}`, ...under], cursorRow: 0, cursorCol: prefix.length + view.cursor };
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
  it("prints the home screen, then leaves on exit, putting the terminal back", async () => {
    const h = harness();
    await h.ready();
    expect(h.out()).toContain("HOME-SCREEN");
    expect(h.raw).toEqual([true]);
    h.send("exit\r");
    expect(await h.result).toBe(0);
    expect(h.out()).toContain("[bye]");
    expect(h.raw).toEqual([true, false]);
    expect(h.out()).toContain("\x1b[?25h\x1b[?2004l");
  });

  it("warms the bulb on start only; a key skips the warm-up and is typed into the prompt", async () => {
    const warm: boolean[] = [];
    const h = harness({
      showHome: async (_status, streams, _opts, isWarm, skip) => {
        warm.push(isWarm);
        if (isWarm) await new Promise((resolve) => skip?.addEventListener("abort", resolve));
        streams.stdout.write("HOME-SCREEN\n");
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    h.send("ho");
    await h.ready();
    await h.until(() => h.lastView().line === "ho");
    h.send("me\r");
    await h.until(() => warm.length === 2);
    expect(warm).toEqual([true, false]);
    h.send("exit\r");
    await h.result;
  });

  it("leaves on quit and on Ctrl+D", async () => {
    const quit = harness();
    await quit.ready();
    quit.send("quit\r");
    expect(await quit.result).toBe(0);

    const eof = harness();
    await eof.ready();
    eof.send(CTRL_D);
    expect(await eof.result).toBe(0);
    expect(eof.out()).toContain("[bye]");
  });

  it("runs a line through main, splitting it like a shell", async () => {
    const seen: { cwd: string; args: string[] }[] = [];
    const h = harness({ commands: makeCommands(seen) });
    await h.ready();
    h.send(`echo "my photo.ARW" 'a b' C:\\x\\y.ARW exposure=+0.5\r`);
    await h.until(() => seen.length === 1);
    expect(seen).toEqual([{ cwd: HERE, args: ["my photo.ARW", "a b", process.platform === "win32" ? "C:\\x\\y.ARW" : "C:xy.ARW", "exposure=+0.5"] }]);
    await h.until(() => h.out().includes("echo:my photo.ARW|a b|"));
    h.send("exit\r");
    await h.result;
  });

  it("leaves the typed line in scrollback, without its footer", async () => {
    const h = harness();
    await h.ready();
    h.send("echo x\r");
    await h.until(() => h.out().includes("echo:x"));
    const before = h.out().slice(0, h.out().indexOf("echo:x"));
    expect(before).toMatch(/cli> echo x\r\n\x1b\[\?25h\x1b\[\?2026l *$/);
    h.send("exit\r");
    await h.result;
  });

  it("paints the line and its footer as you type", async () => {
    const h = harness();
    await h.ready();
    h.send("ech");
    await h.until(() => h.lastView().line === "ech");
    expect(h.lastView().footer).toEqual({ kind: "verb", usage: "echo", summary: "" });
    expect(h.lastView().tokens).toEqual([{ start: 0, end: 3, kind: "plain" }]);
    h.send("o x");
    await h.until(() => h.lastView().line === "echo x");
    expect(h.lastView().tokens[0]).toEqual({ start: 0, end: 4, kind: "verb" });
    h.send("\x15exit\r");
    await h.result;
  });

  it("accepts a leading safelight", async () => {
    const seen: { cwd: string; args: string[] }[] = [];
    const h = harness({ commands: makeCommands(seen) });
    await h.ready();
    h.send("safelight echo one\r");
    await h.until(() => seen.length === 1);
    expect(seen[0].args).toEqual(["one"]);
    h.send("exit\r");
    await h.result;
  });

  it("passes --json through for the one line", async () => {
    const h = harness();
    await h.ready();
    h.send("echo a --json\r");
    await h.until(() => /"echoed": \[\s*"a"\s*\]/.test(h.out()));
    h.send("echo b\r");
    await h.until(() => h.out().includes("echo:b"));
    expect(h.out()).not.toMatch(/"echoed": \[\s*"b"/);
    h.send("exit\r");
    await h.result;
  });

  it("runs help through main", async () => {
    const h = harness();
    await h.ready();
    h.send("help\r");
    await h.until(() => h.out().includes("HELP"));
    h.send("exit\r");
    await h.result;
  });

  it("answers an unknown first word with a note and a suggestion", async () => {
    const h = harness();
    await h.ready();
    h.send("ech x\r");
    await h.until(() => h.err().includes("Did you mean echo?"));
    expect(h.err()).toContain("[unknown:ech x]");
    h.send("exit\r");
    await h.result;
  });

  it("prints home again, and clears", async () => {
    const h = harness();
    await h.ready();
    h.send("home\r");
    await h.until(() => h.count("HOME-SCREEN", h.out()) === 2);
    h.send("clear\r");
    await h.until(() => h.out().includes("\x1b[2J"));
    h.send("exit\r");
    await h.result;
  });

  it("cd changes the folder commands run in and the prompt's project", async () => {
    const seen: { cwd: string; args: string[] }[] = [];
    const moved: string[] = [];
    const target = join(HERE, "output");
    const h = harness({ commands: makeCommands(seen), deps: { chdir: (d) => { moved.push(d); } } });
    await h.ready();
    h.send("cd output\r");
    await h.until(() => h.lastView().projectName === "output");
    expect(moved).toEqual([target]);
    h.send("echo x\r");
    await h.until(() => seen.length === 1);
    expect(seen[0].cwd).toBe(target);
    h.send("exit\r");
    await h.result;
  });

  it("cd to something that is not a folder says so and stays", async () => {
    const moved: string[] = [];
    const h = harness({ deps: { chdir: (d) => { moved.push(d); }, isDirectory: async () => false } });
    await h.ready();
    h.send("cd nowhere\r");
    await h.until(() => h.err().includes("nowhere isn't a folder."));
    expect(moved).toEqual([]);
    h.send("exit\r");
    await h.result;
  });

  it("saves lines to <userData>/slu/history without repeating one, and recalls them with the up arrow", async () => {
    mkdirSync(join(userData, "slu"));
    writeFileSync(join(userData, "slu", "history"), "echo old\n");
    const seen: { cwd: string; args: string[] }[] = [];
    const h = harness({ commands: makeCommands(seen) });
    await h.ready();
    h.send(UP);
    await h.until(() => h.lastView().line === "echo old");
    h.send("\r");
    await h.until(() => seen.length === 1);
    expect(seen[0].args).toEqual(["old"]);
    h.send("echo new\r");
    await h.until(() => seen.length === 2);
    h.send("echo new\r");
    await h.until(() => seen.length === 3);
    h.send("exit\r");
    await h.result;
    expect(readFileSync(join(userData, "slu", "history"), "utf8")).toBe("echo old\necho new\n");
  });

  it("shows a ghost from history and takes it with the right arrow", async () => {
    mkdirSync(join(userData, "slu"));
    writeFileSync(join(userData, "slu", "history"), "echo from history\n");
    const seen: { cwd: string; args: string[] }[] = [];
    const h = harness({ commands: makeCommands(seen) });
    await h.ready();
    h.send("echo f");
    await h.until(() => h.lastView().ghost === "rom history");
    h.send(`${RIGHT}\r`);
    await h.until(() => seen.length === 1);
    expect(seen[0].args).toEqual(["from", "history"]);
    h.send("exit\r");
    await h.result;
  });

  it("Ctrl+C at an empty prompt says how to leave; a second within 2 s leaves", async () => {
    let now = 1000;
    const h = harness({ deps: { now: () => now } });
    await h.ready();
    h.send(CTRL_C);
    await h.until(() => h.out().includes("[interrupt]"));
    now += 500;
    h.send(CTRL_C);
    expect(await h.result).toBe(0);
    expect(h.out()).toContain("[bye]");
  });

  it("Ctrl+C a while after the first does not leave", async () => {
    let now = 1000;
    const h = harness({ deps: { now: () => now } });
    await h.ready();
    h.send(CTRL_C);
    await h.until(() => h.count("[interrupt]", h.out()) === 1);
    now += 5000;
    h.send(CTRL_C);
    await h.until(() => h.count("[interrupt]", h.out()) === 2);
    h.send("exit\r");
    expect(await h.result).toBe(0);
  });

  it("Ctrl+C on a typed line clears it and stays", async () => {
    const h = harness();
    await h.ready();
    h.send(`echo half${CTRL_C}`);
    await h.until(() => h.views.some((v) => v.line === "echo half") && h.lastView().line === "");
    expect(h.out()).not.toContain("[interrupt]");
    h.send("exit\r");
    expect(await h.result).toBe(0);
  });

  it("Ctrl+C while a command runs cancels it and returns to the prompt", async () => {
    const h = harness();
    await h.ready();
    h.send("hang\r");
    await h.until(() => h.out().includes("> hang"));
    await new Promise((r) => setTimeout(r, 20));
    h.interrupt();
    await h.until(() => h.out().includes("[cancelled]"));
    expect(h.err()).not.toContain("Stopped.");
    h.send("echo ok\r");
    await h.until(() => h.out().includes("echo:ok"));
    h.send("exit\r");
    await h.result;
  });

  it("the Ctrl+C key itself cancels a running command, since raw mode sends no signal", async () => {
    const h = harness();
    await h.ready();
    h.send("hang\r");
    await h.until(() => h.out().includes("> hang"));
    await new Promise((r) => setTimeout(r, 20));
    h.send(CTRL_C);
    await h.until(() => h.out().includes("[cancelled]"));
    h.send("exit\r");
    expect(await h.result).toBe(0);
  });
});

describe("pasted lines", () => {
  it("runs every pasted line, in order, and shows each before it runs", async () => {
    const seen: { cwd: string; args: string[] }[] = [];
    const h = harness({ commands: makeCommands(seen) });
    await h.ready();
    h.send("echo a\recho b\recho c\r");
    await h.until(() => seen.length === 3);
    expect(seen.map((x) => x.args[0])).toEqual(["a", "b", "c"]);
    expect(h.out()).toContain("> echo b\r\n");
    h.send("exit\r");
    await h.result;
  });

  it("runs every line of a bracketed paste, in order", async () => {
    const seen: { cwd: string; args: string[] }[] = [];
    const h = harness({ commands: makeCommands(seen) });
    await h.ready();
    h.send("\x1b[200~echo a\r\necho b\r\n\x1b[201~");
    await h.until(() => seen.length === 2);
    expect(seen.map((x) => x.args[0])).toEqual(["a", "b"]);
    h.send("exit\r");
    await h.result;
  });

  it("answers a question from the next line", async () => {
    const h = harness();
    await h.ready();
    h.send("ask\ry\recho after\r");
    await h.until(() => h.out().includes("echo:after"));
    expect(h.out()).toContain("answer:y");
    h.send("exit\r");
    await h.result;
  });

  it("echoes an answer typed after the question", async () => {
    const h = harness();
    await h.ready();
    h.send("ask\r");
    await h.until(() => h.err().includes("Sure? "));
    h.send("nx\x7fo\r");
    await h.until(() => h.out().includes("answer:no"));
    expect(h.err()).toContain("Sure? nx\b \bo\r\n");
    h.send("exit\r");
    await h.result;
  });

  it("drops the rest of a paste when its first command is cancelled", async () => {
    const seen: { cwd: string; args: string[] }[] = [];
    const h = harness({ commands: makeCommands(seen) });
    await h.ready();
    h.send("hang\recho b\recho c\r");
    await h.until(() => h.out().includes("> hang"));
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

describe("pickers", () => {
  const PHOTOS: PhotoFact[] = [
    { rel: "IMG_1.ARW", rating: 3, flag: "pick", label: "none" },
    { rel: "IMG_2.ARW", rating: 0, flag: "none", label: "none" },
  ];
  const showing = (seen: { cwd: string; args: string[] }[] = []): CommandSpec[] => [
    ...makeCommands(seen),
    { ...verb("show", async (_ctx, args) => { seen.push({ cwd: "", args: args.positionals }); return { code: 0 }; }), usage: "show <photos>" },
  ];

  it("opens the photo picker on enter when a photo is missing, then runs with the choice", async () => {
    const seen: { cwd: string; args: string[] }[] = [];
    const h = harness({ commands: showing(seen), photos: PHOTOS });
    await h.ready();
    await new Promise((r) => setTimeout(r, 20));
    h.send("show\r");
    await h.until(() => h.lastView().picker?.title === "Choose a photo");
    h.send("2");
    await h.until(() => h.lastView().picker?.items[0]?.label === "IMG_2.ARW");
    h.send("\r");
    await h.until(() => seen.length === 1);
    expect(seen[0].args).toEqual(["IMG_2.ARW"]);
    h.send("exit\r");
    await h.result;
  });

  it("esc puts the line back untouched", async () => {
    const h = harness({ commands: showing(), photos: PHOTOS });
    await h.ready();
    await new Promise((r) => setTimeout(r, 20));
    h.send("show\r");
    await h.until(() => h.lastView().picker !== null);
    h.send("\x1b");
    await h.until(() => h.lastView().picker === null);
    expect(h.lastView().line).toBe("show");
    h.send("\x15exit\r");
    await h.result;
  });

  it("opens no picker for pasted lines", async () => {
    const seen: { cwd: string; args: string[] }[] = [];
    const h = harness({ commands: showing(seen), photos: PHOTOS });
    await h.ready();
    await new Promise((r) => setTimeout(r, 20));
    h.send("show\recho x\r");
    await h.until(() => seen.length === 2);
    expect(seen[1].args).toEqual(["x"]);
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

describe("open photos", () => {
  const PHOTOS: PhotoFact[] = ["a.NEF", "b.NEF", "c.NEF"].map((rel) => ({ rel, rating: 0, flag: "none", label: "none" }));
  const PAGE_DOWN = "\x1b[6~";
  type Shown = { verb: string; working: WorkingSet | undefined };

  /** The verbs the prompt runs to show a photo, each noting the set it was handed. */
  const viewing = (shown: Shown[], log: string[] = []): CommandSpec[] => [
    ...makeCommands(),
    verb("tools", async (ctx) => { shown.push({ verb: "tools", working: ctx.working }); return { code: 0 }; }),
    {
      ...verb("preview", async (ctx) => { shown.push({ verb: "preview", working: ctx.working }); return { code: 0 }; }),
      options: [{ name: "width", kind: "number", summary: "" }],
    },
    verb("note", async () => { log.push("command"); return { code: 0 }; }),
  ];
  const finding: Partial<ReplDeps> = {
    findOpenSet: async (_ctx, args) => ({ paths: args.positionals.map((p) => join(HERE, p)), index: 0, root: HERE }),
    prefetch: async () => null,
  };
  const lastTools = (shown: Shown[]) => [...shown].reverse().find((s) => s.verb === "tools");

  it("shows the first photo, moves with next, prev and PageDown, and closes", async () => {
    const shown: Shown[] = [];
    const h = harness({ commands: viewing(shown), photos: PHOTOS, deps: finding });
    await h.ready();
    h.send("open a.NEF b.NEF c.NEF\r");
    await h.until(() => shown.length === 2);
    expect(shown.map((s) => s.verb)).toEqual(["tools", "preview"]);
    expect(shown[0].working).toEqual({ paths: ["a.NEF", "b.NEF", "c.NEF"].map((p) => join(HERE, p)), index: 0, root: HERE });
    expect(h.out()).toContain("Opened 3 photos.");
    await h.until(() => h.lastView().open?.name === "a");
    expect(h.lastView().open).toEqual({ name: "a", at: 1, of: 3 });

    h.send("next\r");
    await h.until(() => lastTools(shown)?.working?.index === 1);
    h.send(PAGE_DOWN);
    await h.until(() => lastTools(shown)?.working?.index === 2);
    h.send("next\r");
    await h.until(() => h.out().includes("That's the last open photo."));
    h.send("prev 2\r");
    await h.until(() => lastTools(shown)?.working?.index === 0);

    h.send("close\r");
    await h.until(() => h.out().includes("Closed 3 photos."));
    await h.until(() => h.lastView().open === undefined);
    h.send("exit\r");
    await h.result;
  });

  it("lists the set for open with nothing, the current one marked", async () => {
    const h = harness({ commands: viewing([]), photos: PHOTOS, deps: finding });
    await h.ready();
    h.send("open a.NEF b.NEF --no-preview\r");
    await h.until(() => h.out().includes("Opened 2 photos."));
    h.send("next\r");
    h.send("open\r");
    await h.until(() => /[›>] b\.NEF/.test(h.out()));
    expect(h.out()).toMatch(/ {2}a\.NEF/);
    h.send("exit\r");
    await h.result;
  });

  it("shows the values without the picture with --no-preview", async () => {
    const shown: Shown[] = [];
    const h = harness({ commands: viewing(shown), photos: PHOTOS, deps: finding });
    await h.ready();
    h.send("open a.NEF --no-preview\r");
    await h.until(() => shown.length === 1);
    h.send("echo x\r");
    await h.until(() => h.out().includes("echo:x"));
    expect(shown.map((s) => s.verb)).toEqual(["tools"]);
    h.send("exit\r");
    await h.result;
  });

  it("stops the prefetch of the next photo before a typed command runs", async () => {
    const log: string[] = [];
    const h = harness({
      commands: viewing([], log), photos: PHOTOS,
      deps: {
        ...finding,
        prefetch: (_env, abs, _engine, signal) => new Promise((resolve) => {
          log.push(`prefetch ${basename(abs)}`);
          signal.addEventListener("abort", () => { log.push("stopped"); resolve(null); });
        }),
      },
    });
    await h.ready();
    h.send("open a.NEF b.NEF\r");
    await h.until(() => log.includes("prefetch b.NEF"));
    h.send("note\r");
    await h.until(() => log.includes("command"));
    expect(log).toEqual(["prefetch b.NEF", "stopped", "command"]);
    h.send("exit\r");
    await h.result;
  });

  it("keeps a Ctrl+C that comes before the command is listening for it", async () => {
    const log: string[] = [];
    let release = () => {};
    const h = harness({
      commands: viewing([], log), photos: PHOTOS,
      deps: {
        ...finding,
        prefetch: (_env, _abs, _engine, signal) => new Promise((resolve) => {
          signal.addEventListener("abort", () => { log.push("stopping"); release = () => resolve(null); });
        }),
      },
    });
    await h.ready();
    h.send("open a.NEF b.NEF\r");
    await h.until(() => h.out().includes("Opened 2 photos."));
    h.send("hang\r");
    await h.until(() => log.includes("stopping"));
    h.interrupt();
    release();
    await h.until(() => h.out().includes("[cancelled]"));
    h.send("exit\r");
    await h.result;
  });

  it("drops a photo that left the catalogue at the next command, with one line", async () => {
    const h = harness({
      commands: viewing([]),
      deps: {
        ...finding,
        sources: {
          projectName: async () => "cli",
          photos: async () => ({ photos: PHOTOS.slice(0, 1), look: async () => undefined, root: HERE }),
          values: () => [],
          extensionNames: () => [],
          readDir: async () => [],
        },
      },
    });
    await h.ready();
    h.send("open a.NEF b.NEF --no-preview\r");
    await h.until(() => h.out().includes("Opened 2 photos."));
    await h.until(() => h.lastView().open?.of === 2);
    h.send("echo x\r");
    await h.until(() => h.out().includes("b.NEF isn't in the catalogue any more, so it left the open photos."));
    await h.until(() => h.lastView().open?.of === 1);
    h.send("exit\r");
    await h.result;
  });

  it("closes the set when cd leaves its project", async () => {
    const h = harness({ commands: viewing([]), photos: PHOTOS, deps: finding });
    await h.ready();
    h.send("open a.NEF\r");
    await h.until(() => h.lastView().open?.name === "a");
    h.send("cd ..\r");
    await h.until(() => h.out().includes(`Closed 1 photo in ${basename(HERE)}.`));
    await h.until(() => h.lastView().open === undefined);
    h.send("exit\r");
    await h.result;
  });
});

describe("footers while and after a command runs", () => {
  it("says a command is running under it after a quiet moment", async () => {
    const h = harness();
    await h.ready();
    h.send("hang\r");
    await h.until(() => h.out().includes("(running)"));
    expect(h.views.some((v) => v.footer.kind === "running" && v.footer.label === "Running hang")).toBe(true);
    h.interrupt();
    await h.until(() => h.out().includes("[cancelled]"));
    h.send("exit\r");
    await h.result;
  });

  it("says a long command finished, on the empty line after it", async () => {
    let now = 1000;
    const h = harness({
      commands: [...makeCommands(), verb("slow", async () => { now += 1500; return { code: 0 }; })],
      deps: { now: () => now },
    });
    await h.ready();
    h.send("slow\r");
    await h.until(() => h.lastView().footer.kind === "done");
    expect(h.lastView().footer).toEqual({ kind: "done", message: "slow finished in 1.5 s", ok: true });
    h.send("exit\r");
    await h.result;
  });

  it("offers the fix of the last error as the ghost of the empty line", async () => {
    const h = harness({
      commands: [...makeCommands(), verb("fails", async () => { throw new CliError(2, "x.NEF isn't imported.", "safelight import x.NEF"); })],
    });
    await h.ready();
    h.send("fails\r");
    await h.until(() => h.err().includes("x.NEF isn't imported."));
    await h.until(() => h.lastView().ghost === "import x.NEF");
    h.send("echo y\r");
    await h.until(() => h.out().includes("echo:y"));
    await h.until(() => h.lastView().line === "" && h.lastView().ghost === null);
    h.send("exit\r");
    await h.result;
  });
});

describe("safelight open", () => {
  it("starts the prompt with the photos open when stdin and stdout are terminals", async () => {
    const h = harness({ start: false, commands: [...makeCommands(), openCommand] });
    const run = main(["open", "nowhere.NEF"], h.io);
    await h.until(() => h.err().includes("nowhere.NEF wasn't found."));
    await h.until(() => h.out().includes("\x1b[?2004h"));
    h.send("exit\r");
    expect(await run).toBe(0);
  });
});
