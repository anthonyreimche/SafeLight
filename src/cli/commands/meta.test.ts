import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DoctorItem, HelpScreen, VerbHelp } from "../output/types";
import { CliError, type CommandContext, type CommandOutcome, type ParsedArgs } from "../types";
import { doctorCommand, doctorItems } from "./doctor";
import { helpCommand } from "./help";
import { COMMANDS, NOT_IN_THIS_RELEASE } from "./index";
import { versionCommand } from "./version";

let userData: string;
beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), "slu-meta-"));
});
afterEach(() => rmSync(userData, { recursive: true, force: true }));

interface Recorded { printed: string[]; screen?: HelpScreen; verb?: VerbHelp; doctor?: DoctorItem[] }

function fakeContext(json = false): { ctx: CommandContext; seen: Recorded } {
  const seen: Recorded = { printed: [] };
  const ctx = {
    env: {
      cwd: userData, userData, appRoot: "D:\app", appVersion: "3.3.0", platform: process.platform,
      isTTY: { stdin: false, stdout: false, stderr: false }, env: {},
    },
    json,
    out: {
      print: (t: string) => seen.printed.push(t),
      help: (s: HelpScreen) => ((seen.screen = s), "HELP"),
      verbHelp: (v: VerbHelp) => ((seen.verb = v), "VERB"),
      doctor: (i: DoctorItem[]) => ((seen.doctor = i), "DOCTOR"),
    },
    projects: { find: async () => null },
    extensions: { installed: async () => [] },
  } as unknown as CommandContext;
  return { ctx, seen };
}

const args = (...positionals: string[]): ParsedArgs => ({
  verb: null, positionals, assignments: [], afterDashDash: [], stdinList: false, options: {},
});

describe("version", () => {
  it("prints the version and process version", async () => {
    const { ctx, seen } = fakeContext();
    await versionCommand.run(ctx, args());
    expect(seen.printed).toEqual([expect.stringMatching(/^Safelight Unplugged 3\.3\.0 \(process version \d+\)$/)]);
  });
});

describe("help", () => {
  it("lists every registered verb with its group", async () => {
    const { ctx, seen } = fakeContext();
    await helpCommand.run(ctx, args());
    expect(seen.printed).toEqual(["HELP"]);
    expect(seen.screen?.version).toBe("3.3.0");
    expect(seen.screen?.verbs).toEqual(
      COMMANDS.filter((c) => !NOT_IN_THIS_RELEASE.has(c.verb)).map((c) => ({ verb: c.verb, group: c.group, summary: c.summary })),
    );
  });

  it("shows one verb's usage, options and examples, found by alias too", async () => {
    const { ctx, seen } = fakeContext();
    const set = COMMANDS.find((c) => c.verb === "set");
    expect(set).toBeDefined();
    await helpCommand.run(ctx, args("set"));
    expect(seen.verb).toMatchObject({ verb: "set", usage: set?.usage, examples: set?.examples });
    expect(seen.verb?.options).toHaveLength(set?.options.length ?? -1);
  });

  it("refuses an unknown verb with a suggestion", async () => {
    const { ctx } = fakeContext();
    const failure = await helpCommand.run(ctx, args("sett")).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(CliError);
    expect((failure as CliError).message).toContain("Did you mean set?");
    expect((failure as CliError).code).toBe(1);
  });

  it("gives JSON for --json", async () => {
    const { ctx, seen } = fakeContext(true);
    const outcome: CommandOutcome = await helpCommand.run(ctx, args());
    expect(seen.printed).toEqual([]);
    expect(outcome.json).toMatchObject({ slu: 1, version: "3.3.0" });
  });
});

describe("doctor", () => {
  it("says what it can't know yet when Safelight never ran", async () => {
    const { ctx } = fakeContext();
    const items = await doctorItems(ctx);
    const by = (label: string) => items.find((i) => i.label === label);
    expect(by("Version")?.value).toBe("Safelight Unplugged 3.3.0");
    expect(by("Graphics")?.value).toContain("open Safelight once");
    expect(by("Settings")).toMatchObject({ status: "warn", value: expect.stringContaining("open Safelight once") });
    expect(by("Terminal images")?.value).toContain("none");
    expect(by("Project")?.value).toContain("no catalogue");
  });

  it("reports software rendering, a fresh mirror and a held project lock", async () => {
    writeFileSync(join(userData, "gpu-backend"), "swiftshader\nrenderer-failed\n1 3\n3.3.0\n");
    writeFileSync(
      join(userData, "shared-settings.json"),
      JSON.stringify({ version: 1, appVersion: "3.3.0", writtenAt: Date.now() - 60_000, guiPid: 42, recentProjects: [], storage: {} }),
    );
    const working = join(userData, "shoot", ".safelight");
    mkdirSync(working, { recursive: true });
    const now = Date.now();
    writeFileSync(
      join(working, "writer.lock"),
      JSON.stringify({ app: "safelight", pid: 7, host: "h", since: now, refreshedAt: now, token: "t" }),
    );
    const { ctx } = fakeContext();
    (ctx.projects as { find: unknown }).find = async () => ({ root: join(userData, "shoot"), workingDir: working, location: "in-folder" });
    const items = await doctorItems(ctx);
    const by = (label: string) => items.find((i) => i.label === label);
    expect(by("Graphics")).toMatchObject({ status: "warn", value: expect.stringContaining("software rendering") });
    expect(by("Settings")?.value).toContain("Safelight looks to be running");
    expect(by("Project")).toMatchObject({ status: "warn", value: expect.stringContaining("held by safelight") });
  });

  it.each([
    { idle: 10 * 60_000, status: "warn", text: "held by safelight" },
    { idle: 16 * 60_000, status: "info", text: "stale lock" },
  ])("calls a project lock idle for $idle ms $text", async ({ idle, status, text }) => {
    const working = join(userData, "shoot", ".safelight");
    mkdirSync(working, { recursive: true });
    const refreshedAt = Date.now() - idle;
    writeFileSync(
      join(working, "writer.lock"),
      JSON.stringify({ app: "safelight", pid: 7, host: "h", since: refreshedAt, refreshedAt, token: "t" }),
    );
    const { ctx } = fakeContext();
    (ctx.projects as { find: unknown }).find = async () => ({ root: join(userData, "shoot"), workingDir: working, location: "in-folder" });
    const items = await doctorItems(ctx);
    expect(items.find((i) => i.label === "Project")).toMatchObject({ status, value: expect.stringContaining(text) });
  });

  it("flags extensions without descriptors and ones with catalogue hooks", async () => {
    const dir = join(userData, "extension-descriptors");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "x.hooks@1.0.0.json"),
      JSON.stringify({ version: 1, id: "x.hooks", extVersion: "1.0.0", name: "Hooks", writtenAt: 1, stages: [], uniforms: [], panels: [], hasCatalogHooks: true }),
    );
    const { ctx } = fakeContext();
    const ext = (id: string, name: string) => ({ id, name, version: "1.0.0", enabled: true, trust: "official", repo: null });
    (ctx.extensions as { installed: unknown }).installed = async () => [ext("x.hooks", "Hooks"), ext("x.bare", "Bare")];
    const items = await doctorItems(ctx);
    expect(items.find((i) => i.label === "Extension ranges")?.value).toContain("Bare");
    expect(items.find((i) => i.label === "Catalogue hooks")?.value).toContain("Hooks");
  });

  it("prints through out.doctor, and gives JSON items", async () => {
    const { ctx, seen } = fakeContext();
    await doctorCommand.run(ctx, args());
    expect(seen.printed).toEqual(["DOCTOR"]);
    const json = fakeContext(true);
    const outcome = await doctorCommand.run(json.ctx, args());
    expect(outcome.json).toMatchObject({ slu: 1, items: expect.any(Array) });
  });
});
