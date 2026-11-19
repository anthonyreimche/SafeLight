// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CatalogPhoto } from "@/catalog/types";
import type { EngineEvent, EngineRequest } from "@/engine/protocol";
import { RESERVED_COMMAND_NAMES } from "@/extensions/command-rules";
import { SHARED_SETTINGS_FILE } from "@/state/shared-settings";
import { parseArgs } from "../args";
import type { EngineClient, EngineFrame, RequestOptions } from "../engine-client";
import type { ImportedFile, Output, ProgressState } from "../output/types";
import { BUILTIN_SPECS } from "../prompt/grammar";
import type { CommandContext, CommandSpec, ProjectRef, ReadSession, SelectRequest, Stops, WorkingSet } from "../types";
import { COMMANDS } from "./index";
import { extensionVerbs, runExtensionCommand, withExtensionVerbs } from "./extension-verbs";

let base: string;
let userData: string;

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "slu-verbs-"));
  userData = path.join(base, "profile");
  mkdirSync(userData, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function install(id: string, manifest: Record<string, unknown>): void {
  const dir = path.join(userData, "plugins", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "safelight.json"), JSON.stringify({ id, name: id.toUpperCase(), version: "1.0.0", main: "index.js", ...manifest }));
}

function disable(ids: string[]): void {
  writeFileSync(path.join(userData, "extension-state.json"), JSON.stringify({ version: 1, disabled: ids }));
}

const gmicDeclared = {
  name: "gmic",
  summary: "Runs G'MIC on photos.",
  usage: ["gmic <pipeline…>", "gmic filters [search]"],
  examples: ["gmic blur 3 -- @all", "safelight gmic filters"],
  subcommands: [{ name: "filters", summary: "Lists G'MIC's filters." }],
};

describe("extension verbs", () => {
  it("makes one raw verb per command an enabled extension declares, in the Extensions group", () => {
    install("gmic", { commands: [gmicDeclared] });
    install("quiet", {});
    install("off", { commands: [{ name: "offcmd", summary: "x", usage: ["offcmd"] }] });
    disable(["off"]);
    const { specs, skipped } = extensionVerbs(COMMANDS, userData);
    expect(skipped).toEqual([]);
    expect(specs).toHaveLength(1);
    const [gmic] = specs;
    expect(gmic).toMatchObject({
      verb: "gmic",
      group: "Extensions",
      summary: "Runs G'MIC on photos.",
      rawArgs: true,
      subcommands: [{ name: "filters", summary: "Lists G'MIC's filters." }],
      examples: ["safelight gmic blur 3 -- @all", "safelight gmic filters"],
    });
    expect(gmic.usage.split("\n")[0]).toBe("gmic <pipeline…>");
    expect(withExtensionVerbs(COMMANDS, userData).map((c) => c.verb)).toEqual([...COMMANDS.map((c) => c.verb), "gmic"]);
  });

  it("leaves out a declaration that isn't a usable command, without failing", () => {
    install("odd", {
      commands: [
        { name: "Bad Name", summary: "x", usage: ["x"] },
        { name: "nousage", summary: "x" },
        "gmic",
        { name: "fine", summary: "Fine.", usage: ["fine"], subcommands: "no" },
      ],
    });
    install("worse", { commands: "gmic" });
    const { specs, skipped } = extensionVerbs(COMMANDS, userData);
    expect(specs.map((s) => [s.verb, s.subcommands])).toEqual([["fine", []]]);
    expect(skipped.map((s) => s.extension)).toEqual(["odd", "odd", "odd", "worse"]);
  });

  it("lets a safelight verb and the prompt's own words win, and the lowest id win between extensions", () => {
    install("zed.tools", { commands: [{ ...gmicDeclared, summary: "Zed's." }] });
    install("acme.tools", { commands: [gmicDeclared, { name: "export", summary: "x", usage: ["export"] }, { name: "cd", summary: "x", usage: ["cd"] }] });
    const { specs, skipped } = extensionVerbs(COMMANDS, userData);
    expect(specs.map((s) => [s.verb, s.summary])).toEqual([["gmic", "Runs G'MIC on photos."]]);
    expect(skipped).toEqual([
      { extension: "acme.tools", name: "export", reason: "export is one of safelight's own verbs" },
      { extension: "acme.tools", name: "cd", reason: "cd is one of safelight's own verbs" },
      { extension: "zed.tools", name: "gmic", reason: "gmic is ACME.TOOLS's (acme.tools)" },
    ]);
  });

  it("knows every safelight verb and prompt word as taken", () => {
    const words = [...COMMANDS, ...BUILTIN_SPECS].flatMap((c) => [c.verb, ...(c.aliases ?? [])]);
    for (const word of words) expect(RESERVED_COMMAND_NAMES.has(word)).toBe(true);
  });
});

// ---- running one ------------------------------------------------------------

type CommandRequest = Extract<EngineRequest, { type: "command" }>;
type Script = (req: EngineRequest, options: RequestOptions) => AsyncGenerator<EngineEvent | EngineFrame>;

function photo(id: string, relPath: string): CatalogPhoto {
  return {
    id, filename: path.basename(relPath), relPath, folder: path.posix.dirname(relPath) === "." ? "" : path.posix.dirname(relPath),
    directoryHandle: null, fileHandle: null, thumbnailBlob: null, thumbnailUrl: null, width: 1, height: 1, fileSize: 1,
    mimeType: "image/png", rating: 0, colorLabel: "none", flag: "none", rotation: 0, keywords: [], dateCreated: 0, dateImported: 0, exif: {},
  };
}

interface Rig {
  ctx: CommandContext;
  project: ProjectRef;
  requests: EngineRequest[];
  options: RequestOptions[];
  selected: SelectRequest[];
  printed: string[];
  infos: string[];
  warnings: string[];
  progress: (ProgressState | null)[];
  json: unknown[];
}

function rig(script: Script, over: { json?: boolean; working?: WorkingSet; waitSeconds?: number | null; photos?: CatalogPhoto[] } = {}): Rig {
  const project: ProjectRef = { root: path.join(base, "shoot"), workingDir: path.join(base, "shoot", ".safelight"), location: "in-folder" };
  mkdirSync(path.join(project.workingDir), { recursive: true });
  writeFileSync(path.join(project.workingDir, "catalog.json"), "{}");
  const photos = over.photos ?? [photo("a", "day1/a.png")];
  const r: Rig = { ctx: null as unknown as CommandContext, project, requests: [], options: [], selected: [], printed: [], infos: [], warnings: [], progress: [], json: [] };
  const out = {
    options: { colour: { stdout: false, stderr: false }, unicode: true, width: 80, verbosity: "normal" },
    print: (t: string) => r.printed.push(t),
    json: (doc: unknown) => r.json.push(doc),
    warn: (p: { message: string }) => r.warnings.push(p.message),
    error: () => {},
    info: (t: string) => r.infos.push(t),
    progress: (p: ProgressState | null) => r.progress.push(p),
    importProgress: () => {},
    importedFile: (f: ImportedFile) => `${f.state} ${f.path}`,
    finished: (row: string) => r.printed.push(row),
    working: <T,>(_label: string, task: Promise<T>) => task,
  } as unknown as Output;
  const engine: EngineClient = {
    request(req, options = {}) {
      r.requests.push(req);
      r.options.push(options);
      return script(req, options);
    },
    shutdown: async () => {},
  };
  const session = { project } as unknown as ReadSession;
  r.ctx = {
    env: {
      cwd: project.root, userData, appRoot: "/app", electronBinary: "/electron", appVersion: "3.2.6", platform: process.platform,
      isTTY: { stdin: false, stdout: false, stderr: false }, env: {},
    },
    out,
    json: over.json ?? false,
    verbosity: "normal",
    strict: false,
    yes: false,
    waitSeconds: over.waitSeconds ?? null,
    select: {
      read: async (req: SelectRequest) => {
        r.selected.push(req);
        return { groups: [{ session, photos }], missing: [], close: async () => {} };
      },
    },
    engine: () => engine,
    readStdin: async () => "",
    ...(over.working && { working: over.working }),
  } as unknown as CommandContext;
  return r;
}

const gmicSpec = { verb: "gmic", rawArgs: true, options: [], group: "Extensions", summary: "", usage: "", examples: [], writes: false } as unknown as CommandSpec;
const run = (r: Rig, argv: string[], stops?: Stops, canWrite: (dir: string) => Promise<boolean> = async () => true) =>
  runExtensionCommand(r.ctx, parseArgs(["gmic", ...argv], gmicSpec), "gmic", "gmic", stops, { canWrite });

async function* events(...items: (EngineEvent | EngineFrame)[]): AsyncGenerator<EngineEvent | EngineFrame> {
  for (const item of items) yield item;
}

/** Answers the command with `answer` and an import with one file per saved one. */
const engineScript = (answer: (req: CommandRequest) => (EngineEvent | EngineFrame)[]): Script => (req) => {
  if (req.type === "command") return events(...answer(req), { id: req.id, type: "done" });
  if (req.type === "import" && req.scope.kind === "some") {
    const { id, scope } = req;
    return events(
      ...scope.files.map((relPath, i): EngineEvent => ({ id, type: "import-file", relPath, photoId: `new${i}`, state: "ok" })),
      { id, type: "import-done", moved: [], dropped: [], pending: 0, stopped: null },
      { id, type: "done" },
    );
  }
  throw new Error(`unexpected ${req.type}`);
};

describe("running an extension's command", () => {
  it("with no photos named and none open, sends the words raw with the app's settings, and prints what it says", async () => {
    writeFileSync(path.join(userData, SHARED_SETTINGS_FILE), JSON.stringify({ version: 1, storage: { sl_ext_settings_gmic: "{\"size\":512}" } }));
    const r = rig(engineScript((req) => [
      { id: req.id, type: "command-output", stream: "out", text: "blur: Blur image." },
      { id: req.id, type: "command-output", stream: "info", text: "G'MIC 3.4" },
      { id: req.id, type: "command-output", stream: "warn", text: "slow" },
      { id: req.id, type: "progress", done: 50, total: 100, text: "Running" },
      { id: req.id, type: "progress", done: 0, total: 0 },
      { id: req.id, type: "progress", done: 0, total: 0, text: "" },
    ]));
    expect(await run(r, ["help", "-blur"])).toEqual({ code: 0, json: { slu: 1, result: null, saved: [] } });
    expect(r.selected).toEqual([]);
    expect(r.requests).toHaveLength(1);
    expect(r.requests[0]).toMatchObject({ type: "command", extension: "gmic", name: "gmic", words: ["help", "-blur"], photoIds: [], settings: "{\"size\":512}" });
    expect(r.requests[0]).not.toHaveProperty("project");
    expect(r.printed).toEqual(["blur: Blur image."]);
    expect(r.infos).toContain("G'MIC 3.4");
    expect(r.warnings).toEqual(["slow"]);
    expect(r.progress).toEqual([{ label: "Running", done: 50, total: 100 }, null, null]);
  });

  it("acts on the open photo when none is named, with its project, catalogue stamp and no settings mirrored", async () => {
    const r = rig(engineScript(() => []));
    const current = path.join(base, "shoot", "day1", "a.png");
    r.ctx.working = { paths: [current], index: 0, root: path.join(base, "shoot") };
    await run(r, ["blur", "3"]);
    expect(r.selected[0].specs).toEqual([current]);
    const req = r.requests[0] as CommandRequest;
    expect(req.project).toEqual({ root: r.project.root, workingDir: r.project.workingDir, location: "in-folder" });
    expect(req.photoIds).toEqual(["a"]);
    expect(req.catalogue).toMatch(/^\d/);
    expect(req.settings).toBeNull();
  });

  it("takes the photos named after --", async () => {
    const r = rig(engineScript(() => []));
    await run(r, ["blur", "3", "--", "day1/a.png"]);
    expect(r.selected[0].specs).toEqual(["day1/a.png"]);
  });

  it("imports what the command saved once it is done, prints the new names, and gives them under --json", async () => {
    const r = rig(engineScript((req) => [
      { id: req.id, type: "command-output", stream: "out", text: "not under --json" },
      { id: req.id, type: "command-saved", photoId: "a", relPath: "day1/a-gmic.png" },
      { id: req.id, type: "command-result", value: { pipeline: ["blur", "3"] } },
    ]), { json: true });
    const outcome = await run(r, ["blur", "3", "--", "day1/a.png"]);
    expect(r.requests.map((q) => q.type)).toEqual(["command", "import"]);
    expect(r.requests[1]).toMatchObject({ type: "import", project: { root: r.project.root }, scope: { kind: "some", files: ["day1/a-gmic.png"], folders: [] } });
    expect(r.printed).toEqual([]);
    expect(outcome).toEqual({
      code: 0,
      json: {
        slu: 1,
        result: { pipeline: ["blur", "3"] },
        saved: [{ photo: "a", relPath: "day1/a-gmic.png", path: path.join(r.project.root, "day1", "a-gmic.png"), id: "new0" }],
      },
    });
  });

  it("prints each new photo without --json", async () => {
    const r = rig(engineScript((req) => [{ id: req.id, type: "command-saved", photoId: "a", relPath: "day1/a-gmic.png" }]));
    await run(r, ["blur", "3", "--", "day1/a.png"]);
    expect(r.printed).toEqual(["ok day1/a-gmic.png"]);
  });

  it("fails with the command's error, after importing what it saved before it failed", async () => {
    const r = rig(engineScript((req) => [
      { id: req.id, type: "command-saved", photoId: "a", relPath: "day1/a-gmic.png" },
      { id: req.id, type: "error", code: "command", message: "G'MIC stopped: unknown command 'blurr'." },
    ]));
    await expect(run(r, ["blurr", "--", "day1/a.png"])).rejects.toMatchObject({ code: 1, message: "G'MIC stopped: unknown command 'blurr'." });
    expect(r.requests.map((q) => q.type)).toEqual(["command", "import"]);
  });

  it("waits for Safelight to let go of the project before it sends the command", async () => {
    const r = rig(engineScript(() => []));
    const now = Date.now();
    writeFileSync(
      path.join(r.project.workingDir, "writer.lock"),
      JSON.stringify({ app: "safelight", pid: process.pid, host: hostname(), since: now, refreshedAt: now, token: "t" }),
    );
    await expect(run(r, ["blur", "--", "day1/a.png"])).rejects.toMatchObject({ code: 4 });
    expect(r.requests).toEqual([]);
  });

  it("refuses a photo whose folder is read-only before it sends the command", async () => {
    const r = rig(engineScript(() => []));
    const seen: string[] = [];
    await expect(run(r, ["blur", "--", "day1/a.png"], undefined, async (dir) => {
      seen.push(dir);
      return false;
    })).rejects.toMatchObject({ code: 2, message: expect.stringContaining("read-only") });
    expect(seen).toEqual([path.join(r.project.root, "day1")]);
    expect(r.requests).toEqual([]);
  });

  it("stops the command on Ctrl+C and still imports what it saved", async () => {
    const stopping = new AbortController();
    const forcing = new AbortController();
    const r = rig((req, options) => {
      if (req.type === "command") {
        stopping.abort();
        expect(options.signal?.aborted).toBe(true);
        return events({ id: req.id, type: "command-saved", photoId: "a", relPath: "day1/a-gmic.png" }, { id: req.id, type: "done" });
      }
      return engineScript(() => [])(req, options);
    });
    const outcome = await run(r, ["blur", "--", "day1/a.png"], { signal: stopping.signal, force: forcing.signal });
    expect(outcome.code).toBe(130);
    expect(r.options[0].signal).toBe(stopping.signal);
    expect(r.options[1]).toEqual({ force: forcing.signal });
  });

  it("refuses photos from two projects", async () => {
    const r = rig(engineScript(() => []));
    const other = { project: { ...r.project, root: path.join(base, "other") } } as unknown as ReadSession;
    r.ctx.select.read = async () => ({
      groups: [{ session: { project: r.project } as unknown as ReadSession, photos: [photo("a", "a.png")] }, { session: other, photos: [photo("b", "b.png")] }],
      missing: [],
      close: async () => {},
    });
    await expect(run(r, ["blur", "--", "a.png", "../other/b.png"])).rejects.toMatchObject({ code: 1 });
  });
});
