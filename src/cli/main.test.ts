// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { Readable, Writable } from "node:stream";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CURRENT_PROCESS_VERSION } from "@/catalog/process-version";
import { main, type MainIO } from "./main";
import { COMMANDS } from "./commands";
import { CliError, type CommandSpec, type ParsedArgs, type Stops } from "./types";

const HERE = dirname(fileURLToPath(import.meta.url));

function sink() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, done) {
      chunks.push(chunk.toString());
      done();
    },
  });
  return { stream: Object.assign(stream, { isTTY: false, columns: 80 }) as unknown as NodeJS.WriteStream, text: () => chunks.join("") };
}

function harness(extra: Partial<MainIO> = {}) {
  const stdout = sink();
  const stderr = sink();
  let interrupt: (() => void) | null = null;
  const io: MainIO = {
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: Readable.from([]) as unknown as NodeJS.ReadStream,
    env: { SLU_USER_DATA: join(HERE, "no-such-profile") },
    cwd: HERE,
    platform: process.platform,
    home: HERE,
    moduleFile: join(HERE, "main.ts"),
    onInterrupt: (handler) => {
      interrupt = handler;
      return () => { interrupt = null; };
    },
    ...extra,
  };
  return { io, out: stdout.text, err: stderr.text, interrupt: () => interrupt?.() };
}

const fake = (verb: string, run: CommandSpec["run"]): CommandSpec => ({
  verb, group: "More", summary: "", usage: verb, examples: [], options: [], writes: false, run,
});

const VERSION_LINE = `Safelight Unplugged ${__APP_VERSION__} (process version ${CURRENT_PROCESS_VERSION})\n`;

describe("main", () => {
  it("prints the version for --version and for the version verb", async () => {
    for (const argv of [["--version"], ["version"]]) {
      const h = harness();
      expect(await main(argv, h.io)).toBe(0);
      expect(h.out()).toBe(VERSION_LINE);
      expect(h.err()).toBe("");
    }
  });

  it("tells a bare Electron-as-Node run on Windows that the prompt needs Node", async () => {
    const note = "The interactive prompt needs Node 22 or newer on PATH.";
    const bare = harness({ platform: "win32", underElectron: true });
    await main([], bare.io);
    expect(bare.err()).toContain(note);
    for (const extra of [{ platform: "win32" as const }, { platform: "linux" as const, underElectron: true }]) {
      const h = harness(extra);
      await main([], h.io);
      expect(h.err()).not.toContain(note);
    }
    const withArgs = harness({ platform: "win32", underElectron: true });
    await main(["version"], withArgs.io);
    expect(withArgs.err()).not.toContain(note);
  });

  it("answers an unknown verb with exit 1 and a suggestion", async () => {
    const h = harness();
    expect(await main(["sett", "a.ARW"], h.io)).toBe(1);
    expect(h.err()).toBe(`safelight: "sett" isn't a safelight verb. Did you mean set?\n           safelight help lists them.\n`);
    expect(h.out()).toBe("");
  });

  it("answers a verb nothing is close to without a suggestion", async () => {
    const h = harness();
    expect(await main(["frobnicate"], h.io)).toBe(1);
    expect(h.err()).toBe(`safelight: "frobnicate" isn't a safelight verb.\n           safelight help lists them.\n`);
  });

  it("registers one command per verb, each with its usage", () => {
    const verbs = COMMANDS.map((c) => c.verb);
    expect(new Set(verbs).size).toBe(verbs.length);
    expect(verbs).toEqual(expect.arrayContaining([
      "photos", "tools", "get", "history", "set", "add", "remove", "reset", "undo", "redo", "rate", "flag",
      "label", "copy", "paste", "presets", "apply", "export", "preview", "search", "install", "uninstall",
      "update", "extensions", "enable", "disable", "doctor", "version", "help",
    ]));
    for (const c of COMMANDS) expect(c.usage.startsWith(c.verb)).toBe(true);
  });

  it("maps a verb's refusal to its code, and keeps verbs not in this release off help", async () => {
    const h = harness();
    expect(await main(["auto", "a.ARW"], h.io)).toBe(1);
    expect(h.err()).toBe("safelight: auto isn't in this release yet. Use Auto in Safelight.\n");
    const help = harness();
    expect(await main(["help", "--json"], help.io)).toBe(0);
    const verbs = (JSON.parse(help.out()) as { verbs: { verb: string }[] }).verbs.map((v) => v.verb);
    expect(verbs).not.toContain("auto");
    expect(verbs).not.toContain("save-preset");
    expect(verbs).toContain("set");
  });

  it("prints a command's CliError with its hint and returns its code", async () => {
    const busy = fake("set", async () => {
      throw new CliError(4, "Safelight has D:\\Photos open. Close the folder there, or add --wait.");
    });
    const h = harness({ commands: [busy] });
    expect(await main(["set", "a.ARW"], h.io)).toBe(4);
    expect(h.err()).toBe("safelight: Safelight has D:\\Photos open. Close the folder there, or add --wait.\n");
  });

  it("refuses an option the verb doesn't have", async () => {
    const h = harness();
    expect(await main(["photos", "--colour"], h.io)).toBe(1);
    expect(h.err()).toContain("--colour isn't an option of safelight photos.");
  });

  it("prints one JSON document for an error under --json", async () => {
    const h = harness({ commands: [fake("tools", async () => { throw new CliError(2, "a.ARW isn't there.", "Check the name."); })] });
    expect(await main(["tools", "a.ARW", "--json"], h.io)).toBe(2);
    expect(JSON.parse(h.out())).toEqual({
      slu: 1, ok: false, error: { code: 2, message: "a.ARW isn't there.", hint: "Check the name." },
    });
  });

  it("prints one JSON document for an unknown verb under --json", async () => {
    const h = harness();
    expect(await main(["--json", "sett"], h.io)).toBe(1);
    const doc = JSON.parse(h.out());
    expect(doc).toMatchObject({ slu: 1, ok: false, error: { code: 1 } });
    expect(doc.error.message).toContain("Did you mean set?");
  });

  it("prints the command's JSON under --json, and its text without", async () => {
    const h = harness();
    expect(await main(["version", "--json"], h.io)).toBe(0);
    expect(JSON.parse(h.out())).toEqual({ slu: 1, version: __APP_VERSION__, processVersion: CURRENT_PROCESS_VERSION });
  });

  it("hands the context's global options to the command", async () => {
    let seen: { json: boolean; verbosity: string; strict: boolean; yes: boolean; wait: number | null } | null = null;
    const spy = fake("set", async (ctx) => {
      seen = { json: ctx.json, verbosity: ctx.verbosity, strict: ctx.strict, yes: ctx.yes, wait: ctx.waitSeconds };
      return { code: 0 };
    });
    await main(["set", "-vv", "--strict", "--yes", "--wait=30"], harness({ commands: [spy] }).io);
    expect(seen).toEqual({ json: false, verbosity: "debug", strict: true, yes: true, wait: 30 });
    await main(["set", "-q", "--wait"], harness({ commands: [spy] }).io);
    expect(seen).toMatchObject({ verbosity: "quiet", wait: Infinity });
    await main(["set"], harness({ commands: [spy] }).io);
    expect(seen).toMatchObject({ verbosity: "normal", wait: null });
  });

  it("refuses --wait with something other than seconds", async () => {
    const h = harness({ commands: [fake("set", async () => ({ code: 0 }))] });
    expect(await main(["set", "--wait=soon"], h.io)).toBe(1);
    expect(h.err()).toContain("--wait");
  });

  it("sends --help on a verb to help, naming the verb", async () => {
    let args: ParsedArgs | null = null;
    const help = fake("help", async (_ctx, a) => { args = a; return { code: 0 }; });
    const h = harness({ commands: [help, fake("set", async () => ({ code: 0 }))] });
    expect(await main(["set", "--help"], h.io)).toBe(0);
    expect(args).toMatchObject({ verb: "help", positionals: ["set"] });
  });

  it("runs help when no verb is given", async () => {
    let ran = false;
    const help = fake("help", async () => { ran = true; return { code: 0 }; });
    expect(await main([], harness({ commands: [help] }).io)).toBe(0);
    expect(ran).toBe(true);
  });

  it("returns 130 on Ctrl+C", async () => {
    const h = harness({ commands: [fake("export", () => new Promise(() => {}))] });
    const code = main(["export", "a.ARW"], h.io);
    await new Promise((r) => setTimeout(r, 0));
    h.interrupt();
    expect(await code).toBe(130);
  });

  it("lets a command that stops itself wind down on the first Ctrl+C, and its exit code stand", async () => {
    let stops: Stops | undefined;
    const spec: CommandSpec = {
      ...fake("import", async (ctx) => {
        stops = ctx.stops;
        await new Promise((resolve) => ctx.stops?.signal.addEventListener("abort", resolve));
        await new Promise((r) => setTimeout(r, 5));
        ctx.out.print("Stopped after 1 of 3.");
        return { code: 130 };
      }),
      ownsStop: true,
    };
    const h = harness({ commands: [spec] });
    const code = main(["import"], h.io);
    await new Promise((r) => setTimeout(r, 0));
    h.interrupt();
    expect(await code).toBe(130);
    expect(stops?.signal.aborted).toBe(true);
    expect(stops?.force.aborted).toBe(false);
    expect(h.out()).toBe("Stopped after 1 of 3.\n");
    expect(h.err()).toBe("");
  });

  it("stops such a command at once on a second Ctrl+C", async () => {
    let stops: Stops | undefined;
    const spec: CommandSpec = { ...fake("import", (ctx) => { stops = ctx.stops; return new Promise(() => {}); }), ownsStop: true };
    const h = harness({ commands: [spec] });
    const code = main(["import"], h.io);
    await new Promise((r) => setTimeout(r, 0));
    h.interrupt();
    await new Promise((r) => setTimeout(r, 0));
    h.interrupt();
    expect(await code).toBe(130);
    expect(stops?.force.aborted).toBe(true);
  });

  it("gives the prompt's open photos to the command", async () => {
    let seen: unknown;
    const working = { paths: ["/p/a.ARW"], index: 0, root: "/p" };
    const h = harness({ commands: [fake("get", async (ctx) => { seen = ctx.working; return { code: 0 }; })], working });
    expect(await main(["get"], h.io)).toBe(0);
    expect(seen).toEqual(working);
  });

  it("reports an unexpected failure as safelight: and exit 1", async () => {
    const h = harness({ commands: [fake("get", async () => { throw new Error("disk on fire"); })] });
    expect(await main(["get", "a.ARW"], h.io)).toBe(1);
    expect(h.err()).toBe("safelight: disk on fire\n");
  });

  it("makes no service until a command asks for one", async () => {
    const touched: string[] = [];
    const services = {
      projects: () => { touched.push("projects"); throw new Error("not built"); },
      extensions: () => { touched.push("extensions"); throw new Error("not built"); },
    };
    const h = harness({ services, commands: [fake("get", async (ctx) => { void ctx.extensions; return { code: 0 }; })] });
    expect(await main(["get"], h.io)).toBe(1);
    expect(touched).toEqual(["extensions"]);
  });

  it("reads photo paths from stdin when asked", async () => {
    let text = "";
    const h = harness({
      stdin: Readable.from(["a.ARW\n", "b.ARW\n"]) as unknown as NodeJS.ReadStream,
      commands: [fake("photos", async (ctx) => { text = await ctx.readStdin(); return { code: 0 }; })],
    });
    expect(await main(["photos", "-"], h.io)).toBe(0);
    expect(text).toBe("a.ARW\nb.ARW\n");
  });
});
