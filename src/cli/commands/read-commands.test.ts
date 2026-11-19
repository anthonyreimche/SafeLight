import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendStep } from "@/catalog/edit-steps";
import { freshParams } from "@/catalog/normalize";
import type { CatalogPhoto, EditState } from "@/catalog/types";
import { parseArgs } from "../args";
import type { Output, PhotoRow, ToolRow } from "../output/types";
import {
  CliError,
  type CommandContext,
  type CommandSpec,
  type Look,
  type ProjectRef,
  type ReadSession,
  type SelectRequest,
  type Selection,
  type ToolRef,
  type ValueInfo,
  type ValueService,
} from "../types";
import { getCommand } from "./get";
import { historyCommand } from "./history";
import { photosCommand } from "./photos";
import { toolsCommand } from "./tools";

const project: ProjectRef = { root: "/p", workingDir: "/p/.safelight", location: "in-folder" };

function photo(relPath: string, extra: Partial<CatalogPhoto> = {}): CatalogPhoto {
  return {
    id: relPath, filename: relPath, relPath, folder: "", rating: 0, flag: "none", colorLabel: "none",
    width: 6000, height: 4000, fileSize: 2_100_000, exif: { cameraMake: "SONY", cameraModel: "ILCE-7M4", colorTemperature: 5150 },
    ...extra,
  } as unknown as CatalogPhoto;
}

const tool = (id: string, name: string, extra: Partial<ToolRef> = {}): ToolRef => ({
  id, name, kind: "core", installed: true, enabled: true, settable: true, order: 0, hasCommitHooks: false, ...extra,
});
const exposureTool = tool("safelight.basic", "Basic");
const lcTool = tool("local-contrast", "Local Contrast", { kind: "extension", settable: false });
const goneTool = tool("retinex", "Retinex", { kind: "extension", installed: false, settable: false });

const info = (key: string, t: ToolRef, extra: Partial<ValueInfo> = {}): ValueInfo => ({
  key, label: key, tool: t, kind: "number", min: -5, max: 5, settable: true, ...extra,
});
const exposure = info("exposure", exposureTool);
const temperature = info("temperature", tool("safelight.white-balance", "White Balance"), { min: 2000, max: 50000, unit: "K" });
const lcDetail = info("local-contrast.detail", lcTool, { settable: false });
const retinex = info("retinex.gain", goneTool, { settable: false });

function fakeValues(changed: Set<string>): ValueService {
  const all = [exposure, temperature, lcDetail, retinex];
  return {
    tools: () => [exposureTool, temperature.tool, lcTool, goneTool],
    tool: (name) => {
      throw new CliError(1, name);
    },
    values: (id) => all.filter((v) => v.tool.id === id),
    resolveKey: (input) => {
      const found = all.find((v) => v.key === input);
      if (!found) throw new CliError(1, `"${input}" isn't a value.`);
      return found;
    },
    read: (_look: Look, i) => (i.key === "temperature" ? 5150 : 0),
    isDefault: (_look, i) => !changed.has(i.key),
    apply: () => {
      throw new Error("not used");
    },
    resetTool: () => {
      throw new Error("not used");
    },
    resetKeys: () => {
      throw new Error("not used");
    },
  };
}

interface Recorded {
  printed: string[];
  json: unknown[];
  errors: { message: string; hint?: string }[];
  infos: string[];
  raw: Uint8Array[];
  tables: { photos: PhotoRow[][]; tools: ToolRow[][]; headers: unknown[]; history: unknown[]; summaries: unknown[] };
}

function fakeOut(width = 80): { out: Output; rec: Recorded } {
  const rec: Recorded = { printed: [], json: [], errors: [], infos: [], raw: [], tables: { photos: [], tools: [], headers: [], history: [], summaries: [] } };
  const out = {
    options: { colour: { stdout: false, stderr: false }, unicode: true, width, verbosity: "normal" },
    writeRaw: (b: Uint8Array) => void rec.raw.push(b),
    photoTable: (rows: PhotoRow[]) => (rec.tables.photos.push(rows), "PHOTOS"),
    toolTable: (rows: ToolRow[]) => (rec.tables.tools.push(rows), "TOOLS"),
    photoHeader: (h: unknown) => (rec.tables.headers.push(h), "HEADER"),
    historyList: (rows: unknown) => (rec.tables.history.push(rows), "HISTORY"),
    summary: (s: unknown) => (rec.tables.summaries.push(s), "SUMMARY"),
    print: (t: string) => void rec.printed.push(t),
    json: (d: unknown) => void rec.json.push(d),
    error: (p: { message: string; hint?: string }) => void rec.errors.push(p),
    info: (t: string) => void rec.infos.push(t),
  } as unknown as Output;
  return { out, rec };
}

interface Setup {
  photos?: CatalogPhoto[];
  missing?: Selection<ReadSession>["missing"];
  edits?: Record<string, EditState>;
  changed?: string[];
  json?: boolean;
  stdin?: string;
  width?: number;
  terminal?: Record<string, string>;
  previewFile?: string | null;
}

function context(setup: Setup) {
  const { out, rec } = fakeOut(setup.width);
  const requests: SelectRequest[] = [];
  const closed = { n: 0 };
  const photos = setup.photos ?? [];
  const session: ReadSession = {
    project,
    photos: () => photos,
    photoByRelPath: (r) => photos.find((p) => p.relPath === r),
    previewFile: () => setup.previewFile ?? null,
    edit: async (id) => setup.edits?.[id],
    close: async () => {},
  };
  const ctx = {
    env: { isTTY: { stdin: true, stdout: setup.terminal !== undefined, stderr: true }, env: setup.terminal ?? {} },
    out,
    json: setup.json ?? false,
    values: fakeValues(new Set(setup.changed ?? [])),
    readStdin: async () => setup.stdin ?? "",
    select: {
      read: async (req: SelectRequest): Promise<Selection<ReadSession>> => {
        requests.push(req);
        return { groups: photos.length > 0 ? [{ session, photos }] : [], missing: setup.missing ?? [], close: async () => void closed.n++ };
      },
      write: async () => {
        throw new Error("read commands never write");
      },
    },
  } as unknown as CommandContext;
  return { ctx, rec, requests, closed };
}

const run = (spec: CommandSpec, argv: string[], setup: Setup) => {
  const c = context(setup);
  const args = parseArgs([spec.verb, ...argv], spec);
  return spec.run(c.ctx, args).then((outcome) => ({ outcome, ...c }));
};

const edited = (id: string): EditState =>
  appendStep(undefined, { photoId: id, asShot: 5150 }, "Exposure", { params: { ...freshParams(5150), exposure: 0.7 }, paramBag: {} }, 1000);

describe("safelight photos", () => {
  it("lists a row per photo and a summary, and JSON is a bare array of paths", async () => {
    const photos = [photo("a.ARW", { rating: 3, flag: "pick", colorLabel: "red" }), photo("b.ARW")];
    const r = await run(photosCommand, ["--flag", "pick"], { photos, edits: { "a.ARW": edited("a.ARW") } });
    expect(r.rec.tables.photos[0]).toEqual([
      { name: "a.ARW", rating: 3, flag: "pick", label: "red", edited: true, size: "2.1 MB" },
      { name: "b.ARW", rating: 0, flag: "none", label: "none", edited: false, size: "2.1 MB" },
    ]);
    expect(r.rec.tables.summaries).toEqual([{ photos: 2, stepEach: false, failed: 0, skipped: 0 }]);
    expect(r.requests[0].filters).toEqual({ flag: "pick" });
    expect(r.outcome.code).toBe(0);
    expect(r.outcome.json).toMatchObject({
      slu: 1,
      photos: [{ relPath: "a.ARW", edited: true, rating: 3, flag: "pick", label: "red" }, { relPath: "b.ARW" }],
    });
    expect((r.outcome.json as { photos: { path: string }[] }).photos[0].path.replace(/\\/g, "/")).toBe("/p/a.ARW");
  });

  it("treats no match as zero photos, not a failure", async () => {
    const r = await run(photosCommand, ["--rating", "5"], { missing: [{ spec: ".", reason: "no-match" }] });
    expect(r.outcome.code).toBe(0);
    expect(r.rec.errors).toEqual([]);
    expect(r.rec.tables.summaries).toEqual([{ photos: 0, stepEach: false, failed: 0, skipped: 0 }]);
    expect(r.outcome.json).toEqual({ slu: 1, photos: [] });
  });

  it("exits 2 for photos it can't find and 6 when others were listed", async () => {
    const gone = await run(photosCommand, ["nope.ARW"], { missing: [{ spec: "nope.ARW", reason: "not-found" }] });
    expect(gone.outcome.code).toBe(2);
    expect(gone.rec.errors[0].message).toContain("nope.ARW");
    const some = await run(photosCommand, ["a.ARW", "nope.ARW"], { photos: [photo("a.ARW")], missing: [{ spec: "nope.ARW", reason: "not-found" }] });
    expect(some.outcome.code).toBe(6);
  });

  it("prints nothing for people under --json, and reads stdin paths", async () => {
    const r = await run(photosCommand, ["-"], { photos: [photo("a.ARW")], json: true, stdin: "a.ARW\r\n" });
    expect(r.rec.printed).toEqual([]);
    expect(r.requests[0].stdinPaths).toEqual(["a.ARW"]);
    expect(r.closed.n).toBe(1);
  });
});

describe("safelight tools", () => {
  it("lists tools without values when no photo is named", async () => {
    const r = await run(toolsCommand, [], {});
    expect(r.rec.tables.tools[0]).toEqual([
      { tool: "Basic", state: undefined, values: [] },
      { tool: "White Balance", state: undefined, values: [] },
      { tool: "Local Contrast", state: undefined, values: [] },
      { tool: "Retinex", state: "not installed", values: [] },
    ]);
    expect(r.outcome.json).toMatchObject({ slu: 1, tools: [{ id: "safelight.basic", kind: "core" }, {}, {}, { installed: false }] });
  });

  it("shows the header, core tools, a ✱ for changed values, and the as-shot note", async () => {
    const r = await run(toolsCommand, ["a.ARW"], { photos: [photo("a.ARW")], changed: ["exposure"] });
    expect(r.rec.tables.headers).toEqual([
      { name: "a.ARW", camera: "SONY ILCE-7M4", megapixels: 24, edited: false, processVersion: expect.any(Number) },
    ]);
    const rows = r.rec.tables.tools[0];
    expect(rows.map((t) => t.tool)).toEqual(["Basic", "White Balance"]);
    expect(rows[0].values[0]).toMatchObject({ changed: true });
    expect(rows[1].values[0]).toMatchObject({ changed: false, note: "(as shot 5150)" });
    expect(r.closed.n).toBe(1);
  });

  it("adds idle tools with --all, and marks values kept for a tool that isn't installed", async () => {
    const r = await run(toolsCommand, ["a.ARW", "--all"], { photos: [photo("a.ARW")], changed: ["retinex.gain"] });
    const rows = r.rec.tables.tools[0];
    expect(rows.map((t) => [t.tool, t.state])).toEqual([
      ["Basic", "in use"], ["White Balance", "in use"], ["Local Contrast", "idle"], ["Retinex", "not installed"],
    ]);
    expect(rows[2].values[0].note).toBe("(edit in Safelight)");
    expect(rows[3].values[0].note).toBe("(not installed, values kept)");
  });

  it("shows an extension the edit uses without --all, and hides a missing tool with nothing in it", async () => {
    const used = await run(toolsCommand, ["a.ARW"], { photos: [photo("a.ARW")], changed: ["local-contrast.detail"] });
    expect(used.rec.tables.tools[0].map((t) => t.tool)).toEqual(["Basic", "White Balance", "Local Contrast"]);
  });

  describe("the stored picture", () => {
    let dir: string;
    let file: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "slu-tools-"));
      file = join(dir, "a.jpg");
      writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));
    const iterm = { TERM_PROGRAM: "iTerm.app" };

    it("shows the app's cached preview between the header and the values in iTerm2", async () => {
      const r = await run(toolsCommand, ["a.ARW"], { photos: [photo("a.ARW")], width: 120, terminal: iterm, previewFile: file });
      expect(r.rec.raw).toHaveLength(1);
      expect(new TextDecoder().decode(r.rec.raw[0])).toContain("]1337;File=inline=1;size=4;width=28");
      expect(r.rec.printed.slice(0, 2)).toEqual(["HEADER", "TOOLS"]);
    });

    it("shows nothing elsewhere, with no stored preview, or under --json", async () => {
      const kitty = await run(toolsCommand, ["a.ARW"], { photos: [photo("a.ARW")], width: 120, terminal: { KITTY_WINDOW_ID: "1" }, previewFile: file });
      expect(kitty.rec.raw).toEqual([]);
      const none = await run(toolsCommand, ["a.ARW"], { photos: [photo("a.ARW")], width: 120, terminal: iterm });
      expect(none.rec.raw).toEqual([]);
      const json = await run(toolsCommand, ["a.ARW"], { photos: [photo("a.ARW")], width: 120, terminal: iterm, previewFile: file, json: true });
      expect(json.rec.raw).toEqual([]);
    });
  });

  it("gives the tools and values as JSON", async () => {
    const r = await run(toolsCommand, ["a.ARW"], { photos: [photo("a.ARW")], json: true, changed: ["exposure"] });
    expect(r.outcome.json).toMatchObject({
      slu: 1,
      photo: "a.ARW",
      edited: false,
      tools: [{ name: "Basic", state: "in use", values: [{ key: "exposure", changed: true, min: -5, max: 5 }] }, { name: "White Balance" }],
    });
  });

  it("reads --all as the idle-tools switch, not as every photo", async () => {
    const r = await run(toolsCommand, ["a.ARW", "--all"], { photos: [photo("a.ARW")] });
    expect(r.requests[0].all).toBe(false);
    expect(r.requests[0].specs).toEqual(["a.ARW"]);
  });

  it("refuses several photos", async () => {
    await expect(run(toolsCommand, ["a.ARW"], { photos: [photo("a.ARW"), photo("b.ARW")] })).rejects.toMatchObject({ code: 1 });
  });

  it("exits 2 for a photo it can't find", async () => {
    await expect(run(toolsCommand, ["x.ARW"], { missing: [{ spec: "x.ARW", reason: "not-found" }] })).rejects.toMatchObject({ code: 2 });
  });
});

describe("safelight get", () => {
  it("prints the named values, grouped by tool", async () => {
    const r = await run(getCommand, ["a.ARW", "exposure", "temperature"], { photos: [photo("a.ARW")] });
    expect(r.rec.tables.tools[0].map((t) => [t.tool, t.values.map((v) => v.info.key)])).toEqual([
      ["Basic", ["exposure"]], ["White Balance", ["temperature"]],
    ]);
    expect(r.outcome.json).toEqual({ slu: 1, photo: "a.ARW", values: { exposure: 0, temperature: 5150 } });
  });

  it("prints every tool's values with none named", async () => {
    const r = await run(getCommand, ["a.ARW"], { photos: [photo("a.ARW")] });
    expect(r.rec.tables.tools[0]).toHaveLength(4);
  });

  it("gives the current step exactly as stored", async () => {
    const state = edited("a.ARW");
    const r = await run(getCommand, ["a.ARW"], { photos: [photo("a.ARW")], edits: { "a.ARW": state }, json: true });
    const snap = state.stack[state.currentIndex];
    expect(r.outcome.json).toEqual({ slu: 1, photo: "a.ARW", step: 1, label: "Exposure", params: snap.params, paramBag: snap.paramBag ?? {} });
    expect(r.rec.printed).toEqual([]);
  });

  it("gives a never-edited photo's fresh look with a null step", async () => {
    const r = await run(getCommand, ["a.ARW"], { photos: [photo("a.ARW")], json: true });
    expect(r.outcome.json).toMatchObject({ step: null, label: null, params: { temperature: 5150 } });
  });

  it("refuses an unknown key before reading any photo", async () => {
    await expect(run(getCommand, ["a.ARW", "expsure"], { photos: [photo("a.ARW")] })).rejects.toMatchObject({ code: 1 });
  });
});

describe("safelight history", () => {
  it("lists the steps with the current one marked", async () => {
    const state = edited("a.ARW");
    const r = await run(historyCommand, ["a.ARW"], { photos: [photo("a.ARW")], edits: { "a.ARW": state } });
    expect(r.rec.tables.history[0]).toEqual([
      { index: 0, label: "Original", timestamp: expect.any(Number), current: false },
      { index: 1, label: "Exposure", timestamp: 1000, current: true },
    ]);
    expect(r.outcome.json).toMatchObject({ slu: 1, photo: "a.ARW", steps: [{ index: 0 }, { index: 1, current: true }] });
  });

  it("answers for a photo with no edit", async () => {
    const r = await run(historyCommand, ["a.ARW"], { photos: [photo("a.ARW")] });
    expect(r.outcome.code).toBe(0);
    expect(r.rec.tables.history).toHaveLength(1);
  });

  it("needs a photo", async () => {
    await expect(run(historyCommand, [], {})).rejects.toMatchObject({ code: 1 });
  });
});
