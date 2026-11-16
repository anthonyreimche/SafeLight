// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// @vitest-environment jsdom

// The engine's `command` request: the extension's settings taken first, the
// photos from the catalogue, the command's output as events, and results
// written beside their photos, never over anything and never outside the
// project.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogStorage } from "@/catalog/storage";
import type { CatalogPhoto } from "@/catalog/types";
import { getExtSetting } from "@/extensions/ext-settings";
import { registerCommand, unregisterExtension } from "@/extensions/registry";
import type { CommandContribution, CommandRunContext } from "@/extensions/types";
import { useCatalogStore } from "@/state/catalog-store";
import type { EngineEvent, ProjectWire } from "./protocol";
import { EngineFailure, type CommandRequest, type PortMessage, type RequestOut } from "./rpc";
import { EngineSession, READ_RECORDS, type SessionDeps } from "./session";

const PROJECT: ProjectWire = { root: "D:/shoot", workingDir: "D:/shoot/.safelight", location: "in-folder" };

function photo(id: string, over: Partial<CatalogPhoto> = {}): CatalogPhoto {
  return {
    id,
    filename: `${id}.ARW`,
    relPath: `day1/${id}.ARW`,
    folder: "day1",
    directoryHandle: null,
    fileHandle: { kind: "file", name: `${id}.ARW` } as unknown as FileSystemFileHandle,
    thumbnailBlob: null,
    thumbnailUrl: null,
    width: 6000,
    height: 4000,
    fileSize: 8,
    mimeType: "image/x-sony-arw",
    rating: 0,
    colorLabel: "none",
    flag: "none",
    rotation: 0,
    keywords: [],
    dateCreated: 0,
    dateImported: 0,
    exif: {},
    ...over,
  };
}

function fakeProject(photos: CatalogPhoto[]) {
  const storage: CatalogStorage = {
    putPhoto: async () => {},
    putPhotos: async () => {},
    deletePhotos: async () => {},
    putEditState: async () => {},
    putEditStates: async () => {},
    putPhotoBlob: async () => {},
    flush: async () => {},
    getEditState: async () => undefined,
    close: () => {},
  };
  return vi.fn(async () => ({ photos, storage, readPreview: async () => null }));
}

function recordingOut() {
  const sent: PortMessage[] = [];
  const out: RequestOut = { emit: (event) => sent.push(event), frame: () => {} };
  const events = () => sent.filter((m): m is EngineEvent => "type" in m);
  return { out, events };
}

const request = (over: Partial<CommandRequest> = {}): CommandRequest => ({
  id: 4,
  type: "command",
  extension: "gmic",
  name: "gmic",
  words: [],
  photoIds: [],
  settings: null,
  ...over,
});

const command = (run: CommandContribution["run"], name = "gmic"): CommandContribution => ({ name, summary: "G'MIC", usage: ["gmic <pipeline…>"], run });

function engine(over: Partial<SessionDeps> = {}) {
  const writeFile = vi.fn(async (_path: string, _blob: Blob) => {});
  const exists = vi.fn(async (_path: string) => false);
  const canWrite = vi.fn(async (_dir: string) => true);
  const openProject = fakeProject([photo("a"), photo("b", { filename: "IMG_2.ARW", relPath: "day2/IMG_2.ARW", folder: "day2", copyName: "bw", copyOf: "x" })]);
  const session = new EngineSession({ openProject, writeFile, exists, canWrite, ...over });
  return { session, writeFile, exists, canWrite, openProject };
}

const signal = () => new AbortController().signal;

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  useCatalogStore.getState().replaceCatalog([]);
});

afterEach(() => {
  unregisterExtension("gmic");
  unregisterExtension("other");
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a command", () => {
  it("runs with the words untouched and the photos from the catalogue, after taking the app's settings", async () => {
    localStorage.setItem("sl_ext_settings_gmic", JSON.stringify({ size: 512 }));
    let seen: CommandRunContext | null = null;
    let sizeThen: unknown = null;
    registerCommand("gmic", command(async (ctx) => {
      seen = ctx;
      sizeThen = getExtSetting("gmic", "size", null);
      ctx.print("out line");
      ctx.info("a note");
      ctx.warn("careful");
      ctx.result({ files: 1 });
    }));
    const { session, openProject } = engine();
    const { out, events } = recordingOut();

    await session.command(
      request({ words: ["-v", "-1", "-blur", "3", "--x"], project: PROJECT, photoIds: ["b", "a"], settings: JSON.stringify({ size: 1024 }) }),
      out,
      signal(),
    );

    expect(sizeThen).toBe(1024);
    expect(openProject).toHaveBeenCalledWith(PROJECT.root, READ_RECORDS);
    expect(seen).toMatchObject({ words: ["-v", "-1", "-blur", "3", "--x"], caller: "cli", from: "cli" });
    expect(seen!.photos.map((p) => p.id)).toEqual(["b", "a"]);
    expect(events().filter((e) => e.type !== "progress")).toEqual([
      { id: 4, type: "command-output", stream: "out", text: "out line" },
      { id: 4, type: "command-output", stream: "info", text: "a note" },
      { id: 4, type: "command-output", stream: "warn", text: "careful" },
      { id: 4, type: "command-result", value: { files: 1 } },
    ]);
  });

  it("clears settings the app no longer has", async () => {
    localStorage.setItem("sl_ext_settings_gmic", JSON.stringify({ size: 512 }));
    let sizeThen: unknown = "unread";
    registerCommand("gmic", command(async () => {
      sizeThen = getExtSetting("gmic", "size", null);
    }));
    await engine().session.command(request(), recordingOut().out, signal());
    expect(sizeThen).toBeNull();
  });

  it("opens no project when it is given no photos, and fails when photos come without one", async () => {
    registerCommand("gmic", command(async () => {}));
    const { session, openProject } = engine();
    await session.command(request(), recordingOut().out, signal());
    expect(openProject).not.toHaveBeenCalled();
    await expect(session.command(request({ photoIds: ["a"] }), recordingOut().out, signal())).rejects.toMatchObject({ code: "project" });
    await expect(session.command(request({ project: PROJECT, photoIds: ["zzz"] }), recordingOut().out, signal())).rejects.toMatchObject({ code: "project" });
  });

  it("fails with a message naming the extension when nothing registered the command, or another extension did", async () => {
    const { session } = engine();
    await expect(session.command(request({ name: "gmac" }), recordingOut().out, signal())).rejects.toEqual(
      new EngineFailure("command", "gmic didn't register gmac; is it on?"),
    );
    registerCommand("other", command(async () => {}));
    await expect(session.command(request(), recordingOut().out, signal())).rejects.toMatchObject({ code: "command", message: "gmic didn't register gmic; is it on?" });
  });

  it("fails with the command's own error", async () => {
    registerCommand("gmic", command(async () => {
      throw new Error("G'MIC isn't set up.");
    }));
    await expect(engine().session.command(request(), recordingOut().out, signal())).rejects.toMatchObject({ code: "command", message: "G'MIC isn't set up." });
  });

  it("hands the command the request's signal", async () => {
    let seen: AbortSignal | null = null;
    registerCommand("gmic", command(async (ctx) => {
      seen = ctx.signal;
    }));
    const stop = new AbortController();
    await engine().session.command(request(), recordingOut().out, stop.signal);
    expect(seen).toBe(stop.signal);
  });

  it("sends its progress lines, and a heartbeat every 10 s while it runs", async () => {
    vi.useFakeTimers();
    let finish = () => {};
    registerCommand("gmic", command(async (ctx) => {
      const line = ctx.progress("Rendering");
      line.update("Running G'MIC", 0.5);
      await new Promise<void>((resolve) => { finish = resolve; });
      line.done("Done");
    }));
    const { out, events } = recordingOut();
    const running = engine().session.command(request(), out, signal());
    await vi.advanceTimersByTimeAsync(25_000);
    finish();
    await running;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(events()).toEqual([
      { id: 4, type: "progress", done: 0, total: 0, text: "Rendering" },
      { id: 4, type: "progress", done: 50, total: 100, text: "Running G'MIC" },
      { id: 4, type: "progress", done: 0, total: 0 },
      { id: 4, type: "progress", done: 0, total: 0 },
      { id: 4, type: "progress", done: 0, total: 0, text: "" },
      { id: 4, type: "command-output", stream: "info", text: "Done" },
    ]);
  });
});

describe("saving beside a photo under the CLI", () => {
  const blob = () => new Blob([new Uint8Array([1, 2, 3])]);

  async function saving(
    act: (ctx: CommandRunContext) => Promise<void>,
    deps: Partial<SessionDeps> = {},
    photos?: CatalogPhoto[],
  ) {
    registerCommand("gmic", command(act));
    const e = engine({ ...deps, ...(photos && { openProject: fakeProject(photos) }) });
    const { out, events } = recordingOut();
    await e.session.command(request({ project: PROJECT, photoIds: (photos ?? [photo("a")]).map((p) => p.id) }), out, signal());
    return { ...e, events };
  }

  it("writes <name>-<suffix>.<ext> into the photo's folder, takes -2 on while a name is taken, and says where", async () => {
    const names: string[] = [];
    const taken = new Set(["D:/shoot/day1/a-gmic.png"]);
    const { events } = await saving(
      async (ctx) => {
        names.push(await ctx.saveBeside(ctx.photos[0], blob(), "gmic", "PNG"));
        names.push(await ctx.saveBeside(ctx.photos[0], blob(), "gmic", "png"));
      },
      { exists: vi.fn(async (path: string) => taken.has(path)), writeFile: vi.fn(async (path: string) => void taken.add(path)) },
    );
    expect(names).toEqual(["a-gmic-2.png", "a-gmic-3.png"]);
    expect(events().filter((e) => e.type === "command-saved")).toEqual([
      { id: 4, type: "command-saved", photoId: "a", relPath: "day1/a-gmic-2.png" },
      { id: 4, type: "command-saved", photoId: "a", relPath: "day1/a-gmic-3.png" },
    ]);
  });

  it("names a virtual copy's result after its copy name", async () => {
    const copy = photo("c", { filename: "IMG_2.ARW", relPath: "IMG_2.ARW", folder: "", copyOf: "x", copyName: "bw" });
    const { writeFile } = await saving(async (ctx) => {
      await ctx.saveBeside(ctx.photos[0], blob(), "gmic", "tif");
    }, {}, [copy]);
    expect(writeFile.mock.calls.map(([path]) => path)).toEqual(["D:/shoot/IMG_2_bw-gmic.tif"]);
  });

  it("goes by the catalogue's record of the photo, never by the paths the command hands back", async () => {
    const { writeFile } = await saving(async (ctx) => {
      await ctx.saveBeside({ ...ctx.photos[0], folder: "../..", relPath: "../../x.ARW", filename: "..\\x.ARW" }, blob(), "gmic", "png");
    });
    expect(writeFile.mock.calls.map(([path]) => path)).toEqual(["D:/shoot/day1/a-gmic.png"]);
  });

  it("refuses a folder that leaves the project, a bad suffix or type, and a photo not in the catalogue, writing nothing", async () => {
    const errors: string[] = [];
    const tryIt = (p: Promise<string>) => p.then(() => errors.push("saved"), (e: Error) => errors.push(e.message));
    const { writeFile } = await saving(async (ctx) => {
      await tryIt(ctx.saveBeside(ctx.photos[1], blob(), "gmic", "png"));
      await tryIt(ctx.saveBeside(ctx.photos[0], blob(), "../x", "png"));
      await tryIt(ctx.saveBeside(ctx.photos[0], blob(), "GMIC", "png"));
      await tryIt(ctx.saveBeside(ctx.photos[0], blob(), "gmic", "exe"));
      await tryIt(ctx.saveBeside(photo("nope"), blob(), "gmic", "png"));
    }, {}, [photo("a"), photo("evil", { folder: "../outside", relPath: "../outside/evil.ARW" })]);
    expect(errors).toHaveLength(5);
    expect(errors).not.toContain("saved");
    expect(errors[0]).toMatch(/folder/);
    expect(errors[1]).toMatch(/suffix/);
    expect(errors[3]).toMatch(/type of photo/);
    expect(errors[4]).toMatch(/isn't one of the photos/);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("gives up after -99", async () => {
    let error = "";
    await saving(async (ctx) => {
      await ctx.saveBeside(ctx.photos[0], blob(), "gmic", "png").catch((e: Error) => { error = e.message; });
    }, { exists: vi.fn(async () => true) });
    expect(error).toMatch(/a-gmic-99\.png/);
  });

  it("says why a result can't be saved: a read-only folder, a photo it wasn't given", async () => {
    const answers: (string | null)[] = [];
    const { canWrite } = await saving(async (ctx) => {
      answers.push(await ctx.canSaveBeside(ctx.photos[0]));
      answers.push(await ctx.canSaveBeside(photo("nope")));
    });
    expect(answers[0]).toBeNull();
    expect(answers[1]).toMatch(/isn't one of the photos/);
    expect(canWrite).toHaveBeenCalledWith("D:/shoot/day1");

    const refused = await saving(async (ctx) => {
      answers.push(await ctx.canSaveBeside(ctx.photos[0]));
    }, { canWrite: vi.fn(async () => false) });
    expect(answers[2]).toMatch(/read-only/);
    expect(refused.writeFile).not.toHaveBeenCalled();
  });
});
