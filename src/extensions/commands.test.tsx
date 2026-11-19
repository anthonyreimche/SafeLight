// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// api.commands: the registry's `commands` kind (names, clashes, the sweep) and
// the in-app run (permission, context, saving beside a photo).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto } from "@/catalog/types";
import { useCatalogStore } from "@/state/catalog-store";
import { useProjectStore } from "@/project/project-store";
import { listCommands, registerCommand, registeredCommand, unregisterCommand, unregisterExtension, useRegistry } from "./registry";
import { commandsAPI, type CommandHostDeps } from "./commands";
import { noteCommandPermission } from "./command-permissions";
import { RESERVED_COMMAND_NAMES, saveName } from "./command-rules";
import type { CommandContribution, CommandRunContext } from "./types";

const command = (name: string, run: CommandContribution["run"] = async () => {}): CommandContribution => ({
  name,
  summary: `${name} things`,
  usage: [`${name} <words…>`],
  run,
});

function photo(id: string, over: Partial<CatalogPhoto> = {}): CatalogPhoto {
  return {
    id,
    filename: `${id}.ARW`,
    relPath: `day1/${id}.ARW`,
    folder: "day1",
    directoryHandle: null,
    fileHandle: null,
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

const output = () => {
  const lines: string[] = [];
  return {
    lines,
    print: (t: string) => lines.push(`out ${t}`),
    info: (t: string) => lines.push(`info ${t}`),
    warn: (t: string) => lines.push(`warn ${t}`),
    progress: (t: string) => {
      lines.push(`progress ${t}`);
      return { update: (u: string) => lines.push(`update ${u}`), done: (d?: string) => lines.push(`done ${d ?? ""}`) };
    },
  };
};

const real = useProjectStore.getState();

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  noteCommandPermission({ id: "terminal", permissions: { commands: true } });
  noteCommandPermission({ id: "plain" });
});

afterEach(() => {
  for (const id of ["gmic", "other", "terminal", "plain"]) unregisterExtension(id);
  useCatalogStore.getState().replaceCatalog([]);
  useProjectStore.setState({ root: real.root });
  vi.restoreAllMocks();
});

describe("the commands kind", () => {
  it("keeps a command under its name, with examples and subcommands filled in", () => {
    registerCommand("gmic", { ...command("gmic"), subcommands: [{ name: "filters", summary: "Lists filters" }] });
    expect(registeredCommand("gmic")?.extensionId).toBe("gmic");
    expect(listCommands()).toEqual([
      {
        name: "gmic",
        summary: "gmic things",
        usage: ["gmic <words…>"],
        examples: [],
        subcommands: [{ name: "filters", summary: "Lists filters" }],
        extensionId: "gmic",
      },
    ]);
  });

  it("refuses a name that isn't a lower-case word of 2 to 32", () => {
    for (const name of ["g", "Gmic", "1gmic", "gm_ic", "-gmic", `g${"x".repeat(32)}`, ""]) registerCommand("gmic", command(name));
    expect(listCommands()).toEqual([]);
    expect(console.warn).toHaveBeenCalled();
  });

  it("refuses Safelight's own verbs and the prompt's words", () => {
    for (const name of ["export", "set", "help", "cd", "open", "cls", "quit", "save-preset"]) registerCommand("gmic", command(name));
    expect(listCommands()).toEqual([]);
    expect(RESERVED_COMMAND_NAMES.has("next")).toBe(true);
  });

  it("refuses a command without a run function, summary or usage lines", () => {
    registerCommand("gmic", { ...command("gmic"), run: undefined } as unknown as CommandContribution);
    registerCommand("gmic", { ...command("gmac"), summary: 3 } as unknown as CommandContribution);
    registerCommand("gmic", { ...command("gmoc"), usage: "gmoc" } as unknown as CommandContribution);
    expect(listCommands()).toEqual([]);
  });

  it("leaves a name with the extension that took it first, and lets the holder replace it", () => {
    registerCommand("gmic", command("gmic"));
    registerCommand("other", { ...command("gmic"), summary: "theirs" });
    expect(registeredCommand("gmic")?.extensionId).toBe("gmic");
    registerCommand("gmic", { ...command("gmic"), summary: "new" });
    expect(registeredCommand("gmic")?.summary).toBe("new");
  });

  it("lets only the holder remove it, and drops it with its extension", () => {
    registerCommand("gmic", command("gmic"));
    unregisterCommand("other", "gmic");
    expect(registeredCommand("gmic")).toBeDefined();
    unregisterExtension("gmic");
    expect(registeredCommand("gmic")).toBeUndefined();
  });
});

describe("api.commands", () => {
  it("registers, lists and unregisters as the calling extension, and tells subscribers", () => {
    const api = commandsAPI("gmic");
    const heard = vi.fn();
    const stop = api.subscribe(heard);
    api.register(command("gmic"));
    expect(api.list().map((c) => [c.name, c.extensionId])).toEqual([["gmic", "gmic"]]);
    expect(heard).toHaveBeenCalledTimes(1);
    api.unregister("gmic");
    expect(api.list()).toEqual([]);
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
    api.register(command("gmic"));
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it("refuses to run for an extension whose manifest doesn't ask for commands", async () => {
    commandsAPI("gmic").register(command("gmic"));
    await expect(commandsAPI("plain").run("gmic", { ...output(), words: [], photos: [] })).rejects.toMatchObject({ name: "NotAllowedError" });
    await expect(commandsAPI("never-seen").run("gmic", { ...output(), words: [], photos: [] })).rejects.toMatchObject({ name: "NotAllowedError" });
  });

  it("runs a command with the words untouched, the photos, and the caller's output", async () => {
    let seen: CommandRunContext | null = null;
    commandsAPI("gmic").register(
      command("gmic", async (ctx) => {
        seen = ctx;
        ctx.print("hello");
        ctx.info("note");
        ctx.warn("careful");
        const p = ctx.progress("working");
        p.update("half", 0.5);
        p.done("finished");
        ctx.result({ n: 1 });
        ctx.result({ n: 2 });
      }),
    );
    const out = output();
    const stop = new AbortController();
    const result = await commandsAPI("terminal").run("gmic", { ...out, words: ["-blur", "3", "--x"], photos: [photo("a")], signal: stop.signal });
    expect(result).toEqual({ result: { n: 2 }, saved: [] });
    expect(seen).toMatchObject({ words: ["-blur", "3", "--x"], caller: "app", from: "terminal", signal: stop.signal });
    expect(seen!.photos.map((p) => p.id)).toEqual(["a"]);
    expect(out.lines).toEqual(["out hello", "info note", "warn careful", "progress working", "update half", "done finished"]);
  });

  it("rejects with the command's own error, and for a name nobody registered", async () => {
    commandsAPI("gmic").register(command("gmic", async () => {
      throw new Error("G'MIC isn't set up.");
    }));
    await expect(commandsAPI("terminal").run("gmic", { ...output(), words: [], photos: [] })).rejects.toThrow("G'MIC isn't set up.");
    await expect(commandsAPI("terminal").run("nope", { ...output(), words: [], photos: [] })).rejects.toThrow(/nope/);
  });
});

describe("saving beside a photo in the app", () => {
  const original = photo("a", { filename: "IMG_1.ARW", relPath: "day1/IMG_1.ARW" });
  const nativeRoot = () => ({ kind: "directory", name: "shoot" }) as unknown as FileSystemDirectoryHandle;

  function deps(taken: string[] = []): CommandHostDeps & { calls: { name: string; folder?: string }[] } {
    const calls: { name: string; folder?: string }[] = [];
    return {
      calls,
      importFiles: vi.fn<CommandHostDeps["importFiles"]>(async (files, options) => {
        const [file] = files;
        calls.push({ name: file.name, folder: options?.folder });
        return [taken.includes(file.name) ? { name: file.name, error: `“${file.name}” already exists in this folder.` } : { name: file.name, id: `new-${calls.length}` }];
      }),
      rootPath: () => "D:\\shoot",
      canWrite: vi.fn(async () => true),
    };
  }

  beforeEach(() => {
    useCatalogStore.getState().replaceCatalog([original]);
    useProjectStore.setState({ root: nativeRoot() });
  });

  it("imports the result into the photo's folder as <name>-<suffix>.<ext>, taking -2 on while a name is in use", async () => {
    const d = deps(["IMG_1-gmic.png", "IMG_1-gmic-2.png"]);
    commandsAPI("gmic", d).register(command("gmic", async (ctx) => {
      await ctx.saveBeside(ctx.photos[0], new Blob(["x"]), "gmic", "PNG");
    }));
    const done = await commandsAPI("terminal", d).run("gmic", { ...output(), words: [], photos: [original] });
    expect(d.calls).toEqual([
      { name: "IMG_1-gmic.png", folder: "day1" },
      { name: "IMG_1-gmic-2.png", folder: "day1" },
      { name: "IMG_1-gmic-3.png", folder: "day1" },
    ]);
    expect(done.saved).toEqual(["IMG_1-gmic-3.png"]);
  });

  it("names a virtual copy's result after its copy name, and uses the catalogue's record, not the one passed", async () => {
    const copy = photo("c", { filename: "IMG_1.ARW", relPath: "day1/IMG_1.ARW", copyOf: "a", copyName: "copy" });
    useCatalogStore.getState().replaceCatalog([original, copy]);
    const d = deps();
    const name = await commandsAPI("gmic", d).saveBeside({ ...copy, folder: "../elsewhere" }, new Blob(["x"]), "gmic", "png");
    expect(name).toBe("IMG_1_copy-gmic.png");
    expect(d.calls).toEqual([{ name: "IMG_1_copy-gmic.png", folder: "day1" }]);
  });

  it("refuses a bad suffix, a type Safelight doesn't open, and a photo the catalogue doesn't have", async () => {
    const api = commandsAPI("gmic", deps());
    await expect(api.saveBeside(original, new Blob(["x"]), "G'MIC", "png")).rejects.toThrow(/suffix/);
    await expect(api.saveBeside(original, new Blob(["x"]), "a/b", "png")).rejects.toThrow(/suffix/);
    await expect(api.saveBeside(original, new Blob(["x"]), "gmic", "exe")).rejects.toThrow(/type of photo/);
    await expect(api.saveBeside(photo("zzz"), new Blob(["x"]), "gmic", "png")).rejects.toThrow(/isn't in the open project/);
  });

  it("stops after -99, and passes on an import's other errors", async () => {
    const all = Array.from({ length: 99 }, (_, i) => saveName("IMG_1.ARW", "gmic", "png", i + 1));
    await expect(commandsAPI("gmic", deps(all)).saveBeside(original, new Blob(["x"]), "gmic", "png")).rejects.toThrow(/IMG_1-gmic-99\.png/);
    const failing = deps();
    failing.importFiles = vi.fn<CommandHostDeps["importFiles"]>(async () => [{ name: "IMG_1-gmic.png", error: "The file is too large to import this way." }]);
    await expect(commandsAPI("gmic", failing).saveBeside(original, new Blob(["x"]), "gmic", "png")).rejects.toThrow("too large");
  });

  it("says why a result can't be saved: no project, not a folder on disk, a read-only folder", async () => {
    const d = deps();
    const api = commandsAPI("gmic", d);
    expect(await api.canSaveBeside(original)).toBeNull();
    expect(d.canWrite).toHaveBeenCalledWith("D:\\shoot/day1");

    d.canWrite = vi.fn(async () => false);
    expect(await commandsAPI("gmic", d).canSaveBeside(original)).toMatch(/read-only/);

    d.rootPath = () => null;
    expect(await commandsAPI("gmic", d).canSaveBeside(original)).toMatch(/folder on disk/);

    useProjectStore.setState({ root: null });
    expect(await commandsAPI("gmic", d).canSaveBeside(original)).toMatch(/No project is open/);
  });

  it("gives the same answer in a command's run context", async () => {
    const d = deps();
    d.canWrite = vi.fn(async () => false);
    let answer: string | null = null;
    commandsAPI("gmic", d).register(command("gmic", async (ctx) => {
      answer = await ctx.canSaveBeside(ctx.photos[0]);
    }));
    await commandsAPI("terminal", d).run("gmic", { ...output(), words: [], photos: [original] });
    expect(answer).toMatch(/read-only/);
  });
});

it("the registry starts with no commands", () => {
  expect(useRegistry.getState().commands).toEqual({});
});
