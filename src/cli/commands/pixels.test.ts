import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CatalogPhoto } from "@/catalog/photo";
import type { EngineEvent, EngineRequest } from "@/engine/protocol";
import type { EngineClient, EngineFrame, RequestOptions } from "../engine-client";
import type { Output, ProgressState } from "../output/types";
import { parseArgs } from "../args";
import {
  CliError,
  type CommandContext,
  type CommandSpec,
  type ReadSession,
  type Selection,
} from "../types";
import { exportPhotosCommand, exportSettings, exportTarget } from "./export";
import { previewCommand } from "./preview";

vi.mock("@/catalog/edit-steps", () => ({
  currentLook: () => ({ params: { exposure: 0 }, paramBag: {} }),
}));

const project = { root: "/p", workingDir: "/p/.safelight", location: "in-folder" as const };

function photo(id: string, relPath: string): CatalogPhoto {
  return { id, relPath, filename: relPath, width: 600, height: 400, rotation: 0, exif: {} } as unknown as CatalogPhoto;
}

function selection(photos: CatalogPhoto[], missing: Selection<ReadSession>["missing"] = []): Selection<ReadSession> {
  return {
    groups: photos.length ? [{ session: { project, edit: async () => undefined } as unknown as ReadSession, photos }] : [],
    missing,
    close: async () => {},
  };
}

interface Harness {
  ctx: CommandContext;
  requests: EngineRequest[];
  options: RequestOptions[];
  selected: unknown[];
  printed: string[];
  raw: Uint8Array[];
  json: unknown[];
  errors: string[];
  progress: Array<ProgressState | null>;
  lamps: string[];
}

function harness(opts: {
  photos: CatalogPhoto[];
  missing?: Selection<ReadSession>["missing"];
  /** Each a project of its own, after `photos`'s. */
  more?: CatalogPhoto[][];
  events: (req: EngineRequest, options: RequestOptions) => Array<EngineEvent | EngineFrame>;
  stdoutTTY?: boolean;
  json?: boolean;
  shown?: Array<{ assigns: number }>;
}): Harness {
  const h: Harness = { ctx: null as unknown as CommandContext, requests: [], options: [], printed: [], raw: [], json: [], errors: [], progress: [], lamps: [], selected: [] };
  const out = {
    options: { colour: { stdout: false, stderr: false }, unicode: true, width: 80, verbosity: "normal" },
    exported: (e: { path: string }) => `exported ${e.path}`,
    exportSummary: (s: { exported: number; failed: readonly unknown[] }) => `${s.exported + s.failed.length} photos, ${s.failed.length} failed`,
    finished: (row: string) => h.printed.push(row),
    previewCaption: () => "caption",
    formatValue: (_i: unknown, v: unknown) => String(v),
    print: (t: string) => h.printed.push(t),
    json: (d: unknown) => h.json.push(d),
    warn: () => {},
    error: (p: { message: string }) => h.errors.push(p.message),
    progress: (p: ProgressState | null) => h.progress.push(p),
    working: <T,>(label: string, task: Promise<T>) => { h.lamps.push(label); return task; },
    writeRaw: (b: Uint8Array) => h.raw.push(b),
  } as unknown as Output;
  const engine: EngineClient = {
    async *request(req, options = {}) {
      h.requests.push(req);
      h.options.push(options);
      for (const item of opts.events(req, options)) yield item;
    },
    shutdown: async () => {},
  };
  h.ctx = {
    env: {
      cwd: "/w", userData: "/u", appRoot: "/app", appVersion: "3.3.0", platform: "linux",
      isTTY: { stdin: false, stdout: opts.stdoutTTY ?? false, stderr: false }, env: {},
    },
    out,
    json: opts.json ?? false,
    verbosity: "normal",
    strict: false,
    yes: false,
    waitSeconds: null,
    select: {
      read: async (req: unknown) => {
        h.selected.push(req);
        const picked = selection(opts.photos, opts.missing);
        const others = (opts.more ?? []).map((photos, i) => ({ session: { project: { ...project, root: `/q${i}` } } as unknown as ReadSession, photos }));
        return { ...picked, groups: [...picked.groups, ...others] };
      },
      write: async () => { throw new Error("no"); },
    },
    engine: () => engine,
    preview: { show: async (_p: unknown, _ph: unknown, o: { tryAssigns?: unknown[] }) => { opts.shown?.push({ assigns: o.tryAssigns?.length ?? 0 }); } },
    projects: { openRead: async () => ({ edit: async () => undefined, close: async () => {} }) },
    values: {
      apply: (look: unknown) => ({ look, changes: [], label: "x" }),
    },
    readStdin: async () => "",
  } as unknown as CommandContext;
  return h;
}

function parse(spec: CommandSpec, argv: string[]) {
  return parseArgs([spec.verb, ...argv], spec);
}

describe("exportSettings", () => {
  it("maps options to wire settings and sends only what was typed", () => {
    expect(exportSettings(parse(exportPhotosCommand, ["a.ARW"]))).toEqual({});
    const args = parse(exportPhotosCommand, [
      "a.ARW", "--format", "jpg", "--quality", "90", "--long-edge", "3000",
      "--colour-space", "display-p3", "--bit-depth", "16", "--name", "tmpl", "--existing", "replace",
    ]);
    expect(exportSettings(args)).toEqual({
      format: "jpg", quality: 90, longEdge: 3000, colourSpace: "display-p3", bitDepth: 16, nameTemplate: "tmpl", existing: "replace",
    });
  });

  it("maps --size original and rejects bad values with exit 1", () => {
    expect(exportSettings(parse(exportPhotosCommand, ["a", "--size", "original"])).longEdge).toBe("original");
    for (const bad of [["--format", "gif"], ["--quality", "0"], ["--bit-depth", "12"], ["--colour-space", "lab"], ["--existing", "x"]]) {
      expect(() => exportSettings(parse(exportPhotosCommand, ["a", ...bad]))).toThrow(expect.objectContaining({ code: 1 }));
    }
  });
});

describe("exportTarget", () => {
  it("chooses dir, file or stdout", () => {
    expect(exportTarget(undefined, "/w", 2)).toEqual({ kind: "dir", dir: "/w" });
    expect(exportTarget("/out", "/w", 2)).toEqual({ kind: "dir", dir: resolve("/out") });
    expect(exportTarget("/out/a.jpg", "/w", 1)).toEqual({ kind: "file", path: resolve("/out/a.jpg") });
    expect(exportTarget("-", "/w", 1)).toEqual({ kind: "stdout" });
  });

  it("refuses a file or stdout for several photos", () => {
    expect(() => exportTarget("/out/a.jpg", "/w", 2)).toThrow(CliError);
    expect(() => exportTarget("-", "/w", 2)).toThrow(CliError);
  });
});

describe("export command", () => {
  const done = (id: number): EngineEvent => ({ id, type: "done" });

  it("runs one engine request for the photos and reports each file", async () => {
    const h = harness({
      photos: [photo("a", "a.ARW"), photo("b", "b.ARW")],
      events: (req) => [
        { id: req.id, type: "progress", done: 1, total: 2 },
        { id: req.id, type: "exported", photoId: "a", path: "/o/a.jpg", width: 10, height: 5, colourSpace: "srgb", bytes: 99 },
        { id: req.id, type: "exported", photoId: "b", path: "/o/b.jpg", width: 10, height: 5, colourSpace: "srgb", bytes: 98 },
        done(req.id),
      ],
    });
    const args = parse(exportPhotosCommand, ["a.ARW", "b.ARW", "-o", "/o", "--format", "png"]);
    const outcome = await exportPhotosCommand.run(h.ctx, args);
    expect(outcome.code).toBe(0);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toMatchObject({
      type: "export", photoIds: ["a", "b"], settings: { format: "png" }, target: { kind: "dir", dir: resolve("/o") }, project,
    });
    expect(h.printed).toEqual(["exported /o/a.jpg", "exported /o/b.jpg", "2 photos, 0 failed"]);
  });

  it("reports each photo's state, size and time, with the folder, while it exports", async () => {
    const h = harness({
      photos: [photo("a", "a.ARW"), photo("b", "b.ARW"), photo("c", "c.ARW")],
      events: (req) => [
        { id: req.id, type: "exported", photoId: "a", path: "/o/a.jpg", width: 10, height: 5, colourSpace: "srgb", bytes: 99 },
        { id: req.id, type: "progress", done: 1, total: 3, photoId: "a" },
        { id: req.id, type: "error", code: "decode", message: "bad file", photoId: "b" },
        { id: req.id, type: "progress", done: 2, total: 3, photoId: "b" },
        { id: req.id, type: "exported", photoId: "c", path: "/o/c.jpg", width: 10, height: 5, colourSpace: "srgb", bytes: 7 },
        { id: req.id, type: "progress", done: 3, total: 3, photoId: "c" },
        done(req.id),
      ],
    });
    await exportPhotosCommand.run(h.ctx, parse(exportPhotosCommand, ["x", "-o", "/o"]));
    expect(h.lamps).toEqual(["Starting the engine…"]);
    const live = h.progress.filter((p): p is ProgressState => p !== null);
    const last = live[live.length - 1];
    expect(last).toMatchObject({ label: "Exporting", done: 3, total: 3, folder: resolve("/o") });
    expect(typeof last.startedAt).toBe("number");
    expect(last.items).toEqual([
      { name: "a.jpg", state: "done", ms: expect.any(Number), bytes: 99 },
      { name: "b.ARW", state: "failed", ms: expect.any(Number), error: "bad file" },
      { name: "c.jpg", state: "done", ms: expect.any(Number), bytes: 7 },
    ]);
    expect(h.progress[h.progress.length - 1]).toBeNull();
  });

  it("writes -o - frames to stdout and refuses a terminal", async () => {
    const events = (req: EngineRequest): Array<EngineEvent | EngineFrame> => [
      { id: req.id, type: "exported", photoId: "a", frame: 4, width: 1, height: 1, colourSpace: "srgb", bytes: 3 },
      { frame: 4, bytes: new Uint8Array([1, 2, 3]) },
      done(req.id),
    ];
    const h = harness({ photos: [photo("a", "a.ARW")], events });
    await exportPhotosCommand.run(h.ctx, parse(exportPhotosCommand, ["a.ARW", "-o", "-"]));
    expect(Array.from(h.raw[0])).toEqual([1, 2, 3]);
    expect(h.requests[0]).toMatchObject({ target: { kind: "stdout" } });

    const tty = harness({ photos: [photo("a", "a.ARW")], events, stdoutTTY: true });
    await expect(exportPhotosCommand.run(tty.ctx, parse(exportPhotosCommand, ["a.ARW", "-o", "-"]))).rejects.toMatchObject({ code: 1 });
  });

  it("exits 6 when some photos fail and 2 when all do", async () => {
    const events = (fail: string[]) => (req: EngineRequest): Array<EngineEvent | EngineFrame> => [
      ...["a", "b"].map((id): EngineEvent => fail.includes(id)
        ? { id: req.id, type: "error", code: "decode", message: "bad file", photoId: id }
        : { id: req.id, type: "exported", photoId: id, path: `/o/${id}.jpg`, width: 1, height: 1, colourSpace: "srgb", bytes: 1 }),
      done(req.id),
    ];
    const photos = [photo("a", "a.ARW"), photo("b", "b.ARW")];
    const some = harness({ photos, events: events(["a"]), json: true });
    expect((await exportPhotosCommand.run(some.ctx, parse(exportPhotosCommand, ["x", "-o", "/o"]))).code).toBe(6);
    expect(some.json[0]).toMatchObject({ slu: 1, photos: [{ photo: "a.ARW", ok: false, error: "bad file" }, { photo: "b.ARW", ok: true }] });
    const all = harness({ photos, events: events(["a", "b"]) });
    expect((await exportPhotosCommand.run(all.ctx, parse(exportPhotosCommand, ["x", "-o", "/o"]))).code).toBe(2);
  });

  it("exits 2 for a photo safelight can't find and 3 for an engine failure", async () => {
    const missing = harness({ photos: [], missing: [{ spec: "z.ARW", reason: "not-found" }], events: () => [] });
    await expect(exportPhotosCommand.run(missing.ctx, parse(exportPhotosCommand, ["z.ARW"]))).rejects.toMatchObject({ code: 2 });
    const broken = harness({
      photos: [photo("a", "a.ARW")],
      events: (req) => [{ id: req.id, type: "error", code: "render", message: "GPU lost" }],
    });
    await expect(exportPhotosCommand.run(broken.ctx, parse(exportPhotosCommand, ["a.ARW", "-o", "/o"]))).rejects.toMatchObject({ code: 3 });
  });

  it("sends --try values as overrides for one photo", async () => {
    const h = harness({ photos: [photo("a", "a.ARW")], events: (req) => [done(req.id)] });
    await exportPhotosCommand.run(h.ctx, parse(exportPhotosCommand, ["a.ARW", "exposure=1", "--try", "-o", "/o"]));
    expect(h.requests[0]).toMatchObject({ overrides: { params: { exposure: 0 }, paramBag: {} } });
  });

  it("refuses key=value values without --try, before rendering anything", async () => {
    const h = harness({ photos: [photo("a", "a.ARW")], events: (req) => [done(req.id)] });
    await expect(exportPhotosCommand.run(h.ctx, parse(exportPhotosCommand, ["a.ARW", "exposure=1", "-o", "/o"]))).rejects.toMatchObject({ code: 1 });
    expect(h.requests).toEqual([]);
  });

  it("exports the open photo when none is named, and the set for @all", async () => {
    const h = harness({ photos: [photo("a", "a.ARW")], events: (req) => [done(req.id)] });
    h.ctx.working = { paths: ["/p/a.ARW", "/p/b.ARW"], index: 1, root: "/p" };
    await exportPhotosCommand.run(h.ctx, parse(exportPhotosCommand, ["-o", "/o"]));
    await exportPhotosCommand.run(h.ctx, parse(exportPhotosCommand, ["@all", "-o", "/o"]));
    expect(h.selected).toMatchObject([{ specs: ["/p/b.ARW"] }, { specs: ["/p/a.ARW", "/p/b.ARW"] }]);
  });

  it("on Ctrl+C asks the engine to stop, starts no further project, says what it wrote and exits 130", async () => {
    const stop = new AbortController();
    const force = new AbortController();
    const h = harness({
      photos: [photo("a", "a.ARW"), photo("b", "b.ARW")],
      more: [[photo("c", "c.ARW")]],
      events: (req) => {
        stop.abort();
        return [{ id: req.id, type: "exported", photoId: "a", path: "/o/a.jpg", width: 1, height: 1, colourSpace: "srgb", bytes: 1 }, done(req.id)];
      },
    });
    h.ctx.stops = { signal: stop.signal, force: force.signal };
    const outcome = await exportPhotosCommand.run(h.ctx, parse(exportPhotosCommand, ["x", "-o", "/o"]));
    expect(outcome.code).toBe(130);
    expect(h.requests).toHaveLength(1);
    expect(h.options[0]).toEqual({ signal: stop.signal, force: force.signal });
    expect(h.printed).toEqual(["exported /o/a.jpg", "1 photos, 0 failed"]);
  });

  it("exports the photos it can find, says what it can't, and exits 6", async () => {
    const h = harness({
      photos: [photo("a", "a.ARW")],
      missing: [{ spec: "z.ARW", reason: "not-found" }],
      json: true,
      events: (req) => [
        { id: req.id, type: "exported", photoId: "a", path: "/o/a.jpg", width: 1, height: 1, colourSpace: "srgb", bytes: 1 },
        done(req.id),
      ],
    });
    const outcome = await exportPhotosCommand.run(h.ctx, parse(exportPhotosCommand, ["a.ARW", "z.ARW", "-o", "/o"]));
    expect(outcome.code).toBe(6);
    expect(h.errors).toEqual(["z.ARW wasn't found."]);
    expect(h.json[0]).toMatchObject({ photos: [{ photo: "z.ARW", ok: false }, { photo: "a.ARW", ok: true }] });
  });
});

describe("preview command", () => {
  it("shows one photo through the preview service with the options given", async () => {
    const shown: Array<{ assigns: number }> = [];
    const h = harness({ photos: [photo("a", "a.ARW")], events: () => [], shown });
    const outcome = await previewCommand.run(h.ctx, parse(previewCommand, ["a.ARW", "--width", "60", "--graphics", "blocks"]));
    expect(outcome.code).toBe(0);
    expect(shown).toEqual([{ assigns: 0 }]);
  });

  it("refuses several photos, bad modes and --json", async () => {
    const two = harness({ photos: [photo("a", "a"), photo("b", "b")], events: () => [] });
    await expect(previewCommand.run(two.ctx, parse(previewCommand, ["a", "b"]))).rejects.toMatchObject({ code: 1 });
    const one = harness({ photos: [photo("a", "a")], events: () => [] });
    await expect(previewCommand.run(one.ctx, parse(previewCommand, ["a", "--graphics", "gif"]))).rejects.toMatchObject({ code: 1 });
    const json = harness({ photos: [photo("a", "a")], events: () => [], json: true });
    await expect(previewCommand.run(json.ctx, parse(previewCommand, ["a"]))).rejects.toMatchObject({ code: 1 });
  });

  it("hands --try values to the context's preview, which renders them unstored", async () => {
    const shown: Array<{ assigns: number }> = [];
    const h = harness({ photos: [photo("a", "a.ARW")], events: () => [], shown });
    await previewCommand.run(h.ctx, parse(previewCommand, ["a.ARW", "exposure=1", "--try", "--graphics", "blocks", "--width", "10"]));
    expect(shown).toEqual([{ assigns: 1 }]);
    expect(h.requests).toEqual([]);
  });

  it("refuses key=value values without --try", async () => {
    const shown: Array<{ assigns: number }> = [];
    const h = harness({ photos: [photo("a", "a.ARW")], events: () => [], shown });
    await expect(previewCommand.run(h.ctx, parse(previewCommand, ["a.ARW", "exposure=1"]))).rejects.toMatchObject({ code: 1 });
    expect(shown).toEqual([]);
  });
});
