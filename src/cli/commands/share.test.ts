// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CURRENT_PROCESS_VERSION, LEGACY_PROCESS_VERSION, freshParams, type CatalogPhoto, type EditState } from "@/catalog/types";
import { parseArgs } from "../args";
import { CliError, type CommandContext, type CommandSpec, type ParsedArgs, type ReadSession, type WriteSession } from "../types";
import { applyCommand } from "./apply";
import { copyCommand } from "./copy";
import { pasteCommand } from "./paste";
import { presetsCommand } from "./presets";
import { parsePresets } from "./share-support";

let stored = "[]";
vi.mock("../mirror", () => ({
  readSharedSettings: () => ({ version: 1, appVersion: "", writtenAt: 0, guiPid: null, recentProjects: [], storage: { "safelight-presets": stored } }),
}));

const photo = (id: string): CatalogPhoto => ({ id, relPath: `day/${id}.ARW`, exif: { colorTemperature: 5200 } }) as unknown as CatalogPhoto;
const project = { root: "/p", workingDir: "/p/.safelight", location: "in-folder" } as const;

type Missing = { spec: string; reason: "not-found" | "not-in-catalogue" | "no-match" };

interface Harness {
  ctx: CommandContext;
  lines: string[];
  warnings: string[];
  written: EditState[];
  edits: Map<string, EditState>;
}

function harness(userData: string, photos: CatalogPhoto[], missing: Missing[] = []): Harness {
  const lines: string[] = [];
  const warnings: string[] = [];
  const written: EditState[] = [];
  const edits = new Map<string, EditState>();
  const session = {
    project,
    photos: () => photos,
    photoByRelPath: () => undefined,
    edit: async (id: string) => edits.get(id),
    putEdits: async (states: EditState[]) => { written.push(...states); },
    putPhotos: async () => {},
    close: async () => {},
  };
  const selection = { groups: [{ session: session as unknown as WriteSession & ReadSession, photos }], missing, close: async () => {} };
  const ctx = {
    env: { userData },
    json: false,
    waitSeconds: null,
    readStdin: async () => "",
    select: { read: async () => selection, write: async () => selection },
    values: {
      tool: (name: string) => ({ id: name }),
      values: (id: string) => (id === "basic" ? [{ key: "exposure" }, { key: "contrast" }] : []),
    },
    preview: { show: async () => {} },
    out: {
      resultLine: (r: { photo: string; step?: number }) => `${r.photo} step ${r.step ?? "-"}`,
      summary: (s: { photos: number }) => `${s.photos} photos`,
      print: (t: string) => { lines.push(t); },
      json: () => {},
      warn: (p: { message: string }) => { warnings.push(p.message); },
    },
  } as unknown as CommandContext;
  return { ctx, lines, warnings, written, edits };
}

const parse = (spec: CommandSpec, argv: string[]): ParsedArgs => parseArgs([spec.verb, ...argv], spec);

let userData: string;
beforeEach(async () => { userData = await mkdtemp(join(tmpdir(), "slu-share-")); });
afterEach(async () => { await rm(userData, { recursive: true, force: true }); });

function editedState(id: string, exposure: number, processVersion = CURRENT_PROCESS_VERSION): EditState {
  const params = { ...freshParams(5200), exposure, straighten: 3, processVersion };
  return { photoId: id, stack: [{ timestamp: 1, label: "Original", params: freshParams(5200) }, { timestamp: 2, label: "Exposure", params }], currentIndex: 1 };
}

describe("copy then paste", () => {
  it("round-trips through the clipboard file, one step per photo, per-photo tools left out", async () => {
    const src = harness(userData, [photo("a")]);
    src.edits.set("a", editedState("a", 0.7));
    expect((await copyCommand.run(src.ctx, parse(copyCommand, ["a.ARW"]))).code).toBe(0);

    const dst = harness(userData, [photo("b"), photo("c")]);
    const outcome = await pasteCommand.run(dst.ctx, parse(pasteCommand, ["b.ARW", "c.ARW"]));
    expect(outcome.code).toBe(0);
    expect(dst.written.map((s) => s.photoId)).toEqual(["b", "c"]);
    const last = dst.written[0].stack[dst.written[0].currentIndex];
    expect(last.label).toBe("Paste Settings");
    expect(last.params.exposure).toBe(0.7);
    expect(last.params.straighten).toBe(0);
  });

  it("--tools copies only that tool's values", async () => {
    const src = harness(userData, [photo("a")]);
    const state = editedState("a", 0.7);
    state.stack[1].params.contrast = 20;
    state.stack[1].params.saturation = 9;
    src.edits.set("a", state);
    await copyCommand.run(src.ctx, parse(copyCommand, ["a.ARW", "--tools", "basic"]));
    const dst = harness(userData, [photo("b")]);
    await pasteCommand.run(dst.ctx, parse(pasteCommand, ["b.ARW"]));
    const params = dst.written[0].stack[dst.written[0].currentIndex].params;
    expect(params.exposure).toBe(0.7);
    expect(params.contrast).toBe(20);
    expect(params.saturation).toBe(0);
  });

  it("paste --from needs no clipboard file", async () => {
    const h = harness(userData, [photo("a")]);
    h.edits.set("a", editedState("a", 1.1));
    const outcome = await pasteCommand.run(h.ctx, parse(pasteCommand, ["a.ARW", "--from", "a.ARW"]));
    expect(outcome.code).toBe(0);
    expect(h.written).toHaveLength(0);
  });

  it("paste --from reads the source by its spec alone, not the batch's --all, filters or stdin", async () => {
    const h = harness(userData, [photo("a")]);
    h.edits.set("a", editedState("a", 1.1));
    const read = vi.spyOn(h.ctx.select, "read");
    await pasteCommand.run(h.ctx, parse(pasteCommand, ["b.ARW", "--from", "a.ARW", "--all", "--rating", "3+", "--edited", "--recursive"]));
    expect(read.mock.calls[0][0]).toMatchObject({ specs: ["a.ARW"], all: false, recursive: false, filters: {}, stdinPaths: [] });
  });

  it("paste with nothing copied exits 2", async () => {
    const h = harness(userData, [photo("b")]);
    await expect(pasteCommand.run(h.ctx, parse(pasteCommand, ["b.ARW"]))).rejects.toMatchObject({ code: 2 });
  });

  it("a photo outside any catalogue is refused with exit 2; a partial batch exits 6", async () => {
    const src = harness(userData, [photo("a")]);
    src.edits.set("a", editedState("a", 0.7));
    await copyCommand.run(src.ctx, parse(copyCommand, ["a.ARW"]));
    const all = harness(userData, [], [{ spec: "x.ARW", reason: "not-in-catalogue" }]);
    expect((await pasteCommand.run(all.ctx, parse(pasteCommand, ["x.ARW"]))).code).toBe(2);
    const some = harness(userData, [photo("b")], [{ spec: "x.ARW", reason: "not-in-catalogue" }]);
    expect((await pasteCommand.run(some.ctx, parse(pasteCommand, ["b.ARW", "x.ARW"]))).code).toBe(6);
    expect(some.warnings[0]).toContain("x.ARW");
  });
});

describe("presets and apply", () => {
  const preset = { id: "p1", name: "Warm film", group: "Film", params: { exposure: 0.3, processVersion: CURRENT_PROCESS_VERSION }, paramBag: { "a.k": 1 } };

  it("parses well-formed presets and drops the rest", () => {
    expect(parsePresets(JSON.stringify([preset, { id: 1 }]))).toHaveLength(1);
    expect(parsePresets("nope")).toEqual([]);
    expect(parsePresets(undefined)).toEqual([]);
  });

  it("lists presets by group", async () => {
    stored = JSON.stringify([preset, { id: "p2", name: "Plain", params: {} }]);
    const h = harness(userData, []);
    await presetsCommand.run(h.ctx, parse(presetsCommand, []));
    expect(h.lines).toEqual(["Film", "  Warm film", "Ungrouped", "  Plain"]);
  });

  it("apply keeps the photo's process version", async () => {
    stored = JSON.stringify([preset]);
    const h = harness(userData, [photo("b")]);
    h.edits.set("b", editedState("b", 0, LEGACY_PROCESS_VERSION));
    const outcome = await applyCommand.run(h.ctx, parse(applyCommand, ["warm film", "b.ARW"]));
    expect(outcome.code).toBe(0);
    const last = h.written[0].stack[h.written[0].currentIndex];
    expect(last.params.exposure).toBe(0.3);
    expect(last.params.processVersion).toBe(LEGACY_PROCESS_VERSION);
  });

  it("an unknown preset is a usage error", async () => {
    stored = JSON.stringify([preset]);
    const h = harness(userData, [photo("b")]);
    const err = await applyCommand.run(h.ctx, parse(applyCommand, ["nope", "b.ARW"])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(1);
  });
});
