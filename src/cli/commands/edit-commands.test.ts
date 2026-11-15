// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it } from "vitest";
import { freshParams, type CatalogPhoto, type EditState } from "@/catalog/types";
import { parseArgs } from "../args";
import {
  CliError,
  type ApplyResult,
  type CommandContext,
  type CommandSpec,
  type Look,
  type ProjectRef,
  type ToolRef,
  type ValueInfo,
  type WriteSession,
} from "../types";
import { setCommand } from "./set";
import { addCommand } from "./add";
import { removeCommand } from "./remove";
import { resetCommand } from "./reset";
import { undoCommand } from "./undo";
import { redoCommand } from "./redo";
import { rateCommand } from "./rate";
import { flagCommand } from "./flag";
import { labelCommand } from "./label";

const PROJECT: ProjectRef = { root: "/p", workingDir: "/p/.safelight", location: "in-folder" };
const BASIC: ToolRef = { id: "safelight.basic", name: "Basic", kind: "core", installed: true, enabled: true, settable: true, order: 1, hasCommitHooks: false };
const LOCAL: ToolRef = { id: "local-contrast", name: "Local Contrast", kind: "extension", installed: true, enabled: true, settable: false, order: 2, hasCommitHooks: false };
const EXPOSURE: ValueInfo = { key: "exposure", label: "Exposure", tool: BASIC, kind: "number", min: -5, max: 5, unit: "EV", settable: true };

function photo(id: string, over: Partial<CatalogPhoto> = {}): CatalogPhoto {
  return {
    id, relPath: `day/${id}.ARW`, rating: 0, colorLabel: "none", flag: "none", exif: { colorTemperature: 5200 },
    ...over,
  } as CatalogPhoto;
}

function editWith(photoId: string, labels: string[], currentIndex: number): EditState {
  return {
    photoId,
    currentIndex,
    stack: labels.map((label, i) => ({ timestamp: i, label, params: freshParams(5200), paramBag: {} })),
  };
}

function harness(photos: CatalogPhoto[], edits: Record<string, EditState> = {}, over: { missing?: { spec: string; reason: "not-found" | "not-in-catalogue" | "no-match" }[] } = {}) {
  const written = { edits: [] as EditState[], photos: [] as CatalogPhoto[] };
  const log = { printed: [] as string[], warned: [] as string[], errors: [] as string[], json: [] as unknown[] };
  let closed = 0;
  let requested: unknown = null;
  const session: WriteSession = {
    project: PROJECT,
    photos: () => photos,
    photoByRelPath: () => undefined,
    edit: async (id) => edits[id],
    putEdits: async (s) => { written.edits.push(...s); },
    putPhotos: async (p) => { written.photos.push(...p); },
    close: async () => undefined,
  };
  const value = (look: Look, key: string): unknown => (look.params as unknown as Record<string, unknown>)[key];
  const ctx = {
    json: false,
    strict: false,
    waitSeconds: null,
    out: {
      resultLine: (r: { photo: string; changes: { label: string; value: string }[]; note?: string; step?: number }) =>
        `${r.photo}|${r.changes.map((c) => `${c.label}=${c.value}`).join(",")}|${r.step ?? ""}|${r.note ?? ""}`,
      summary: (s: { photos: number; failed: number; skipped: number }) => `summary ${s.photos} failed ${s.failed} skipped ${s.skipped}`,
      formatValue: (_i: ValueInfo, v: unknown) => String(v),
      toolTable: () => "table",
      print: (t: string) => log.printed.push(t),
      warn: (p: { message: string }) => log.warned.push(p.message),
      error: (p: { message: string }) => log.errors.push(p.message),
      info: () => undefined,
      json: (d: unknown) => log.json.push(d),
    },
    readStdin: async () => "",
    preview: { show: async () => undefined },
    select: {
      write: async (req: unknown) => {
        requested = req;
        return { groups: photos.length > 0 ? [{ session, photos }] : [], missing: over.missing ?? [], close: async () => { closed++; } };
      },
    },
    values: {
      tool: (name: string) => {
        if (name === "basic") return BASIC;
        if (name === "local-contrast") return LOCAL;
        throw new CliError(1, `"${name}" isn't a tool.`);
      },
      values: () => [EXPOSURE],
      resolveKey: (input: string) => {
        if (input === "exposure") return EXPOSURE;
        throw new CliError(1, `"${input}" isn't a value.`);
      },
      read: (look: Look, info: ValueInfo) => value(look, info.key),
      isDefault: () => true,
      apply(look: Look, assigns: { key: string; value: string }[]): ApplyResult {
        const a = assigns[0];
        if (a.key === "local-contrast.detail") throw new CliError(1, "Local Contrast doesn't support slu yet. Set it in Safelight.");
        const before = value(look, "exposure");
        const after = Math.min(5, Number(a.value));
        return {
          look: { ...look, params: { ...look.params, exposure: after } },
          changes: [{ info: EXPOSURE, before, after, clamped: Number(a.value) > 5 ? { requested: Number(a.value), limit: 5 } : undefined }],
          label: "Exposure",
        };
      },
      resetTool: (look: Look) => ({ ...look, params: { ...look.params, exposure: 0, contrast: 0 } }),
      resetKeys: (look: Look, keys: string[] | "all") => ({ ...look, params: { ...look.params, exposure: keys === "all" ? 0 : 0 } }),
    },
  } as unknown as CommandContext;
  return { ctx, written, log, closed: () => closed, requested: () => requested };
}

async function run(spec: CommandSpec, ctx: CommandContext, argv: string[]) {
  return spec.run(ctx, parseArgs([spec.verb, ...argv], spec));
}

describe("set", () => {
  it("appends one step per photo and closes the selection", async () => {
    const h = harness([photo("a"), photo("b")]);
    const outcome = await run(setCommand, h.ctx, ["a.ARW", "b.ARW", "exposure=0.5"]);
    expect(outcome.code).toBe(0);
    expect(h.written.edits).toHaveLength(2);
    const first = h.written.edits[0];
    expect(first.stack.map((s) => s.label)).toEqual(["Original", "Exposure"]);
    expect(first.stack[1].params.exposure).toBe(0.5);
    expect(first.currentIndex).toBe(1);
    expect(h.log.printed.at(-1)).toBe("summary 2 failed 0 skipped 0");
    expect(h.closed()).toBe(1);
  });

  it("passes the photo specs and filters to the selector", async () => {
    const h = harness([photo("a")]);
    await run(setCommand, h.ctx, ["a.ARW", "exposure=1", "--rating", "3+", "--flag", "pick", "--unedited", "-r"]);
    expect(h.requested()).toMatchObject({ specs: ["a.ARW"], recursive: true, filters: { rating: { min: 3, max: 5 }, flag: "pick", edited: false } });
  });

  it("warns when a value is clamped and still succeeds", async () => {
    const h = harness([photo("a")]);
    const outcome = await run(setCommand, h.ctx, ["a.ARW", "exposure=7"]);
    expect(outcome.code).toBe(0);
    expect(h.log.warned[0]).toBe("Exposure 7 is past its limit, so it was set to 5.");
  });

  it("writes nothing when the value service refuses, and still closes", async () => {
    const h = harness([photo("a")]);
    await expect(run(setCommand, h.ctx, ["a.ARW", "local-contrast.detail=1"])).rejects.toThrow("Local Contrast doesn't support slu yet. Set it in Safelight.");
    expect(h.written.edits).toHaveLength(0);
    expect(h.closed()).toBe(1);
  });

  it("skips a photo whose values already match", async () => {
    const state = editWith("a", ["Original"], 0);
    state.stack[0].params = { ...state.stack[0].params, exposure: 0.5 };
    const h = harness([photo("a")], { a: state });
    const outcome = await run(setCommand, h.ctx, ["a.ARW", "exposure=0.5"]);
    expect(outcome.code).toBe(0);
    expect(h.written.edits).toHaveLength(0);
    expect(h.log.printed[0]).toContain("no change");
  });

  it("needs at least one value and some photos", async () => {
    const h = harness([photo("a")]);
    await expect(run(setCommand, h.ctx, ["a.ARW"])).rejects.toMatchObject({ code: 1 });
    await expect(run(setCommand, h.ctx, ["exposure=1"])).rejects.toMatchObject({ code: 1 });
  });

  it("treats everything after -- as photos", async () => {
    const h = harness([photo("a")]);
    await run(setCommand, h.ctx, ["exposure=1", "--", "odd=name.ARW"]);
    expect(h.requested()).toMatchObject({ specs: ["odd=name.ARW"] });
  });

  it("exits 2 when a photo isn't in a catalogue and none else matched", async () => {
    const h = harness([], {}, { missing: [{ spec: "x.ARW", reason: "not-in-catalogue" }] });
    const outcome = await run(setCommand, h.ctx, ["x.ARW", "exposure=1"]);
    expect(outcome.code).toBe(2);
    expect(h.log.errors[0]).toContain("isn't in a Safelight catalogue");
    expect(h.written.edits).toHaveLength(0);
    expect(h.closed()).toBe(1);
  });

  it("exits 6 when some photos were done and some missing", async () => {
    const h = harness([photo("a")], {}, { missing: [{ spec: "x.ARW", reason: "not-found" }] });
    const outcome = await run(setCommand, h.ctx, ["a.ARW", "x.ARW", "exposure=1"]);
    expect(outcome.code).toBe(6);
    expect(h.written.edits).toHaveLength(1);
  });

  it("prints one JSON document with --json", async () => {
    const h = harness([photo("a")]);
    (h.ctx as { json: boolean }).json = true;
    await run(setCommand, h.ctx, ["a.ARW", "exposure=1"]);
    expect(h.log.printed).toHaveLength(0);
    expect(h.log.json[0]).toMatchObject({ slu: 1, photos: [{ photo: "day/a.ARW", ok: true, changed: true }] });
  });
});

describe("add", () => {
  it("refuses an extension tool with the plan's text and exit 1", async () => {
    const h = harness([photo("a")]);
    await expect(run(addCommand, h.ctx, ["a.ARW", "local-contrast"])).rejects.toMatchObject({
      code: 1,
      message: "Local Contrast doesn't support slu yet. Set it in Safelight.",
    });
    expect(h.requested()).toBeNull();
  });

  it("lists a core tool's keys and writes nothing", async () => {
    const h = harness([photo("a")]);
    const outcome = await run(addCommand, h.ctx, ["a.ARW", "basic"]);
    expect(outcome.code).toBe(0);
    expect(h.log.printed).toContain("table");
    expect(h.written.edits).toHaveLength(0);
    expect(h.closed()).toBe(1);
  });
});

describe("remove and reset", () => {
  it("remove resets a tool in one step", async () => {
    const edits = { a: { ...editWith("a", ["Original", "Exposure"], 1) } };
    edits.a.stack[1].params = { ...edits.a.stack[1].params, exposure: 1 };
    const h = harness([photo("a")], edits);
    await run(removeCommand, h.ctx, ["a.ARW", "local-contrast"]);
    expect(h.written.edits[0].stack.at(-1)?.label).toBe("Reset Local Contrast");
  });

  it("reset splits keys from photos and labels the step", async () => {
    const edits = { a: editWith("a", ["Original", "Exposure"], 1) };
    edits.a.stack[1].params = { ...edits.a.stack[1].params, exposure: 1 };
    const h = harness([photo("a")], edits);
    await run(resetCommand, h.ctx, ["a.ARW", "exposure"]);
    expect(h.requested()).toMatchObject({ specs: ["a.ARW"] });
    expect(h.written.edits[0].stack.at(-1)?.label).toBe("Reset Exposure");
  });

  it("reset with no keys resets the whole edit", async () => {
    const edits = { a: editWith("a", ["Original", "Exposure"], 1) };
    edits.a.stack[1].params = { ...edits.a.stack[1].params, exposure: 1 };
    const h = harness([photo("a")], edits);
    await run(resetCommand, h.ctx, ["a.ARW"]);
    expect(h.written.edits[0].stack.at(-1)?.label).toBe("Reset");
  });
});

describe("undo and redo", () => {
  it("moves back n steps and writes the moved cursor", async () => {
    const h = harness([photo("a")], { a: editWith("a", ["Original", "One", "Two"], 2) });
    await run(undoCommand, h.ctx, ["a.ARW", "2"]);
    expect(h.written.edits[0].currentIndex).toBe(0);
    expect(h.requested()).toMatchObject({ specs: ["a.ARW"] });
  });

  it("defaults to one step and redoes forward", async () => {
    const h = harness([photo("a")], { a: editWith("a", ["Original", "One", "Two"], 0) });
    await run(redoCommand, h.ctx, ["a.ARW"]);
    expect(h.written.edits[0].currentIndex).toBe(1);
  });

  it("writes nothing at the end of the history or for a never-edited photo", async () => {
    const h = harness([photo("a"), photo("b")], { a: editWith("a", ["Original"], 0) });
    const outcome = await run(undoCommand, h.ctx, ["a.ARW", "b.ARW"]);
    expect(outcome.code).toBe(0);
    expect(h.written.edits).toHaveLength(0);
  });
});

describe("rate, flag and label", () => {
  it("changes the record without a history step", async () => {
    const h = harness([photo("a")]);
    await run(rateCommand, h.ctx, ["a.ARW", "4"]);
    expect(h.written.photos[0].rating).toBe(4);
    expect(h.written.edits).toHaveLength(0);
  });

  it("flags and labels", async () => {
    const h = harness([photo("a")]);
    await run(flagCommand, h.ctx, ["a.ARW", "pick"]);
    await run(labelCommand, h.ctx, ["a.ARW", "Red"]);
    expect(h.written.photos.map((p) => [p.flag, p.colorLabel])).toEqual([["pick", "none"], ["none", "red"]]);
  });

  it("refuses bad values with exit 1", async () => {
    const h = harness([photo("a")]);
    await expect(run(rateCommand, h.ctx, ["a.ARW", "6"])).rejects.toMatchObject({ code: 1 });
    await expect(run(flagCommand, h.ctx, ["a.ARW", "star"])).rejects.toMatchObject({ code: 1 });
    await expect(run(labelCommand, h.ctx, ["a.ARW", "pink"])).rejects.toMatchObject({ code: 1 });
  });

  it("skips a photo that already has the value", async () => {
    const h = harness([photo("a", { rating: 4 })]);
    await run(rateCommand, h.ctx, ["a.ARW", "4"]);
    expect(h.written.photos).toHaveLength(0);
  });
});
