import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineEvent, EngineRequest } from "@/engine/protocol";
import { parseArgs } from "../args";
import type { EngineClient, EngineFrame, RequestOptions } from "../engine-client";
import type { ImportedFile, ImportPlan as OutputImportPlan, ImportProgress, ImportSummary, Output } from "../output/types";
import type { CommandContext, ProjectRef, Stops } from "../types";
import { importCommand, importPhotos } from "./import";

type ImportRequest = Extract<EngineRequest, { type: "import" }>;

let base: string;

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "slu-import-"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function touch(rel: string, text = rel): string {
  const file = path.join(base, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

function catalogue(doc: unknown = { version: 1, photos: [], edits: [] }): void {
  touch(".safelight/catalog.json", JSON.stringify(doc));
}

function guiLock(): string {
  const now = Date.now();
  return touch(".safelight/writer.lock", JSON.stringify({ app: "safelight", pid: process.pid, host: hostname(), since: now, refreshedAt: now, token: "t" }));
}

async function find(abs: string): Promise<ProjectRef | null> {
  let dir = abs;
  for (;;) {
    if (existsSync(path.join(dir, ".safelight", "catalog.json"))) return { root: dir, workingDir: path.join(dir, ".safelight"), location: "in-folder" };
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

type Script = (req: ImportRequest, options: RequestOptions) => AsyncGenerator<EngineEvent | EngineFrame>;

interface Harness {
  ctx: CommandContext;
  requests: ImportRequest[];
  printed: string[];
  errors: string[];
  warnings: string[];
  progress: Array<ImportProgress | null>;
  plans: OutputImportPlan[];
  summaries: ImportSummary[];
  shutdowns: number;
}

function harness(script: Script, over: Partial<CommandContext> = {}): Harness {
  const h: Harness = { ctx: null as unknown as CommandContext, requests: [], printed: [], errors: [], warnings: [], progress: [], plans: [], summaries: [], shutdowns: 0 };
  const out = {
    options: { colour: { stdout: false, stderr: false }, unicode: true, width: 80, verbosity: "normal" },
    print: (t: string) => h.printed.push(t),
    json: () => {},
    warn: (p: { message: string }) => h.warnings.push(p.message),
    error: (p: { message: string }) => h.errors.push(p.message),
    info: () => {},
    importProgress: (p: ImportProgress | null) => h.progress.push(p),
    importPlan: (p: OutputImportPlan) => { h.plans.push(p); return "plan"; },
    importedFile: (f: ImportedFile) => `${f.state} ${f.path}${f.error ? `: ${f.error}` : ""}`,
    finished: (row: string) => h.printed.push(row),
    importSummary: (s: ImportSummary) => { h.summaries.push(s); return "summary"; },
    working: <T,>(_label: string, task: Promise<T>) => task,
  } as unknown as Output;
  const engine: EngineClient = {
    request(req, options = {}) {
      if (req.type !== "import") throw new Error(`unexpected ${req.type}`);
      h.requests.push(req);
      return script(req, options);
    },
    shutdown: async () => { h.shutdowns++; },
  };
  h.ctx = {
    env: {
      cwd: base, userData: path.join(base, "profile"), appRoot: "/app", electronBinary: "/electron", appVersion: "3.3.0", platform: process.platform,
      isTTY: { stdin: false, stdout: false, stderr: false }, env: {},
    },
    out,
    json: false,
    verbosity: "normal",
    strict: false,
    yes: false,
    waitSeconds: null,
    projects: { find },
    engine: () => engine,
    readStdin: async () => "",
    ...over,
  } as unknown as CommandContext;
  return h;
}

const run = (h: Harness, argv: string[], stops?: Partial<Stops>) => importPhotos(h.ctx, parseArgs(["import", ...argv], importCommand), stops);

const done = (over: Partial<Extract<EngineEvent, { type: "import-done" }>> = {}): EngineEvent =>
  ({ id: 1, type: "import-done", moved: [], dropped: [], pending: 0, stopped: null, ...over });
const plan = (newFiles: number, created = false): EngineEvent =>
  ({ id: 1, type: "import-plan", workingDir: path.join(base, ".safelight"), location: "in-folder", created, newFiles });
const file = (relPath: string, state: "ok" | "no-preview" | "failed" = "ok"): EngineEvent =>
  ({ id: 1, type: "import-file", relPath, state, ...(state === "failed" ? { error: "couldn't be read" } : { photoId: `id-${relPath}` }) });

function scripted(events: EngineEvent[]): Script {
  return async function* (req) {
    for (const event of events) yield { ...event, id: req.id } as EngineEvent;
    yield { id: req.id, type: "done" };
  };
}

describe("import", () => {
  it("sends the GUI's open as one import request: scope, camera data, backup", async () => {
    catalogue();
    touch("a.jpg");
    const h = harness(scripted([plan(1), file("a.jpg"), done()]));
    const outcome = await run(h, ["a.jpg"]);
    expect(outcome.code).toBe(0);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toMatchObject({
      type: "import", project: { root: base }, scope: { kind: "some", files: ["a.jpg"], folders: [] }, metadata: true, keepBackup: true,
    });
    expect(h.shutdowns).toBe(1);
  });

  it("leaves the camera data for later with --quick, and the summary says so", async () => {
    catalogue();
    const h = harness(scripted([plan(1), file("a.NEF"), done({ pending: 1 })]));
    await run(h, ["--quick"]);
    expect(h.requests[0]).toMatchObject({ scope: { kind: "all" }, metadata: false });
    expect(h.summaries[0]).toMatchObject({ pending: 1, stopped: null });
  });

  it("says where a new catalogue starts", async () => {
    touch("a.jpg");
    const h = harness(scripted([plan(1, true), file("a.jpg"), done()]));
    await run(h, []);
    expect(h.plans).toEqual([{ project: path.basename(base), newFiles: 1, started: { workingDir: path.join(base, ".safelight"), external: false } }]);
  });

  it("names the catalogue folder in this system's own separators", async () => {
    touch("a.jpg");
    const slashed = path.join(base, ".safelight").replace(/\\/g, "/");
    const slashedPlan: EngineEvent = { id: 1, type: "import-plan", workingDir: slashed, location: "in-folder", created: true, newFiles: 1 };
    const h = harness(scripted([slashedPlan, file("a.jpg"), done()]));
    await run(h, []);
    expect(h.plans[0]?.started?.workingDir).toBe(path.join(base, ".safelight"));
  });

  it("does a dry run from the scan alone, with no engine", async () => {
    catalogue({ version: 1, photos: [{ id: "1", relPath: "old.jpg" }], edits: [] });
    touch("a.jpg");
    const h = harness(scripted([]), { json: true });
    const outcome = await run(h, ["--dry-run"]);
    expect(h.requests).toEqual([]);
    expect(outcome).toEqual({
      code: 0,
      json: {
        slu: 1, dryRun: true,
        project: { root: base, workingDir: path.join(base, ".safelight"), location: "in-folder", created: false },
        new: [path.join(base, "a.jpg")], gone: ["old.jpg"], otherFiles: 0,
      },
    });
  });

  it("is exit 4 before any engine starts when Safelight has the folder open", async () => {
    catalogue();
    guiLock();
    const h = harness(scripted([done()]));
    await expect(run(h, [])).rejects.toMatchObject({ code: 4, message: `Safelight has ${base} open. Close the folder there, or add --wait.` });
    expect(h.requests).toEqual([]);
  });

  it("waits for the lock with --wait, then imports", async () => {
    catalogue();
    const lock = guiLock();
    const h = harness(scripted([plan(0), done()]), { waitSeconds: 5 });
    setTimeout(() => rmSync(lock), 150);
    expect((await run(h, [])).code).toBe(0);
    expect(h.requests).toHaveLength(1);
  });

  it("gives up waiting with exit 4 when --wait runs out", async () => {
    catalogue();
    guiLock();
    const h = harness(scripted([done()]), { waitSeconds: 0.2 });
    await expect(run(h, [])).rejects.toMatchObject({ code: 4 });
    expect(h.requests).toEqual([]);
  });

  it("is exit 4 when the engine finds the lock held", async () => {
    catalogue();
    const h = harness(async function* (req) {
      yield { id: req.id, type: "error", code: "locked", message: "held", heldBy: { app: "safelight", pid: 1, host: "h", since: 0, refreshedAt: 0 } };
    });
    await expect(run(h, [])).rejects.toMatchObject({ code: 4 });
  });

  it("stops on Ctrl+C through the engine's cancel: exit 130, stopped interrupted", async () => {
    catalogue();
    const stop = new AbortController();
    const h = harness(async function* (req, options) {
      yield { id: req.id, type: "import-plan", workingDir: path.join(base, ".safelight"), location: "in-folder", created: false, newFiles: 3 };
      yield { id: req.id, type: "progress", phase: "files", done: 1, total: 3 };
      yield { id: req.id, type: "import-file", relPath: "a.jpg", photoId: "a", state: "ok" };
      stop.abort();
      expect(options.signal?.aborted).toBe(true);
      yield { id: req.id, type: "import-done", moved: [], dropped: [], pending: 0, stopped: "interrupted" };
      yield { id: req.id, type: "done" };
    }, { json: true });
    const outcome = await run(h, [], { signal: stop.signal });
    expect(outcome.code).toBe(130);
    expect(outcome.json).toMatchObject({ stopped: "interrupted", imported: [{ relPath: "a.jpg", id: "a" }] });
    expect(h.summaries).toEqual([]);
  });

  it("is exit 4 when Safelight takes the folder over mid-import", async () => {
    catalogue();
    const h = harness(scripted([
      plan(412),
      { id: 1, type: "progress", phase: "files", done: 137, total: 412 },
      done({ stopped: "safelight-opened" }),
    ]));
    const outcome = await run(h, []);
    expect(outcome.code).toBe(4);
    expect(h.summaries[0]).toMatchObject({ project: path.basename(base), total: 412, stopped: "safelight-opened" });
  });

  it("is exit 6 when some files couldn't be read", async () => {
    catalogue();
    const h = harness(scripted([plan(2), file("a.jpg"), file("b.NEF", "failed"), done()]));
    expect((await run(h, [])).code).toBe(6);
    expect(h.printed).toEqual(["plan", "ok a.jpg", "failed b.NEF: couldn't be read", "summary"]);
    expect(h.summaries[0]).toMatchObject({ imported: 1, total: 2, failed: ["b.NEF"] });
  });

  it("is exit 2 when nothing named can be imported", async () => {
    catalogue();
    const h = harness(scripted([]));
    await expect(run(h, ["gone.jpg", "missing.NEF"])).rejects.toMatchObject({ code: 2 });
    expect(h.errors).toHaveLength(1);
    expect(h.requests).toEqual([]);
  });

  it("copies outside files in, then imports them", async () => {
    mkdirSync(path.join(base, "p"));
    touch("p/.safelight/catalog.json", JSON.stringify({ version: 1, photos: [], edits: [] }));
    const from = touch("card/IMG_1.ARW");
    const h = harness(scripted([plan(1), file("IMG_1.ARW"), done()]), { json: true });
    h.ctx.env.cwd = path.join(base, "p");
    const outcome = await run(h, ["--copy", "../card/IMG_1.ARW"]);
    expect(existsSync(path.join(base, "p", "IMG_1.ARW"))).toBe(true);
    expect(h.requests[0].scope).toEqual({ kind: "some", files: ["IMG_1.ARW"], folders: [] });
    expect(outcome.json).toMatchObject({ copied: [{ from, to: path.join(base, "p", "IMG_1.ARW") }] });
  });

  it("answers --json in the import shape", async () => {
    catalogue();
    const h = harness(scripted([
      plan(2),
      file("a.jpg"),
      file("Day 2/b.NEF", "no-preview"),
      file("c.NEF", "failed"),
      done({ moved: [{ id: "m", from: "IMG_9.ARW", to: "Day 1/IMG_9.ARW" }], dropped: [{ id: "d", relPath: "old.jpg", edited: true }], pending: 2 }),
    ]), { json: true });
    const outcome = await run(h, []);
    expect(outcome.json).toEqual({
      slu: 1,
      project: { root: base, workingDir: path.join(base, ".safelight"), location: "in-folder", created: false },
      imported: [
        { path: path.join(base, "a.jpg"), relPath: "a.jpg", id: "id-a.jpg", preview: true },
        { path: path.join(base, "Day 2", "b.NEF"), relPath: "Day 2/b.NEF", id: "id-Day 2/b.NEF", preview: false },
      ],
      failed: [{ path: path.join(base, "c.NEF"), relPath: "c.NEF", error: "couldn't be read" }],
      copied: [],
      moved: [{ id: "m", from: "IMG_9.ARW", to: "Day 1/IMG_9.ARW" }],
      dropped: [{ id: "d", relPath: "old.jpg", edited: true }],
      pending: 2,
      stopped: null,
    });
  });
});
