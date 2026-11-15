import { describe, expect, it } from "vitest";
import { GLOBAL_OPTIONS } from "./args";
import { createCompleter, type CompleteDeps } from "./complete";
import type { CommandSpec } from "./types";

const spec = (verb: string, optionNames: string[] = []): CommandSpec => ({
  verb, group: "More", summary: "", usage: verb, examples: [], writes: false,
  options: optionNames.map((name) => ({ name, kind: "flag", summary: "" })),
  run: async () => ({ code: 0 }),
});

const FILES: Record<string, { name: string; dir: boolean }[]> = {
  "/work": [
    { name: "IMG_1.ARW", dir: false },
    { name: "IMG_2.ARW", dir: false },
    { name: "notes.txt", dir: false },
    { name: "My Shoot", dir: true },
    { name: ".hidden", dir: true },
    { name: "Italy", dir: true },
  ],
  "/work/My Shoot": [{ name: "A 1.NEF", dir: false }, { name: "b.NEF", dir: false }],
};

function deps(over: Partial<CompleteDeps> = {}): CompleteDeps {
  return {
    platform: "linux",
    cwd: () => "/work",
    commands: [spec("set", ["all"]), spec("get"), spec("reset"), spec("tools", ["recursive"]), spec("install"), spec("uninstall"), spec("enable"), spec("help")],
    builtins: ["exit", "cd", "clear"],
    readDir: async (dir) => FILES[dir] ?? [],
    valueKeys: () => ["exposure", "contrast", "temperature"],
    extensionNames: () => ["local-contrast", "paint-layers"],
    ...over,
  };
}

const run = (line: string, over?: Partial<CompleteDeps>) => createCompleter(deps(over))(line);

describe("completer", () => {
  it("completes verbs and built-ins in the first word", async () => {
    const [hits, on] = await run("e");
    expect(on).toBe("e");
    expect(hits).toEqual(["enable", "exit"]);
  });

  it("accepts a leading safelight", async () => {
    expect((await run("safelight to"))[0]).toEqual(["tools"]);
  });

  it("completes the verb's options and the global ones", async () => {
    const [hits, on] = await run("tools --r");
    expect(on).toBe("--r");
    expect(hits).toEqual(["--recursive"]);
    const all = (await run("set --"))[0];
    expect(all).toContain("--all");
    for (const g of GLOBAL_OPTIONS) expect(all).toContain(`--${g.name}`);
  });

  it("completes photos and folders, favouring photo files", async () => {
    const [hits] = await run("tools ");
    expect(hits).toEqual(["Italy/", "\"My Shoot/", "IMG_1.ARW", "IMG_2.ARW"]);
  });

  it("falls back to other files when no photo matches", async () => {
    expect((await run("tools no"))[0]).toEqual(["notes.txt"]);
  });

  it("hides dotfiles until a dot is typed", async () => {
    expect((await run("tools ."))[0]).toEqual([".hidden/"]);
  });

  it("quotes names with spaces and keeps the typed folder", async () => {
    const [hits, on] = await run("tools \"My Shoot/");
    expect(on).toBe("\"My Shoot/");
    expect(hits).toEqual(["\"My Shoot/A 1.NEF\"", "\"My Shoot/b.NEF\""]);
    expect((await run("tools My\\ Shoot/b"))[1]).toBe("My\\ Shoot/b");
  });

  it("completes only folders for cd", async () => {
    expect((await run("cd "))[0]).toEqual(["Italy/", "\"My Shoot/"]);
  });

  it("matches without regard to case on Windows and keeps what was typed", async () => {
    const [hits] = await run("tools img_1", { platform: "win32" });
    expect(hits).toEqual(["img_1.ARW"]);
  });

  it("offers value keys after a photo on set, get and reset", async () => {
    expect((await run("set IMG_1.ARW ex"))[0]).toEqual(["exposure="]);
    expect((await run("get IMG_1.ARW co"))[0]).toEqual(["contrast"]);
    expect((await run("reset IMG_1.ARW t"))[0]).toEqual(["temperature"]);
  });

  it("offers no value keys before a photo or for other verbs", async () => {
    expect((await run("set ex"))[0]).toEqual([]);
    expect((await run("tools IMG_1.ARW ex"))[0]).toEqual([]);
  });

  it("completes installed extension names for uninstall and enable", async () => {
    expect((await run("uninstall l"))[0]).toEqual(["local-contrast"]);
    expect((await run("enable "))[0]).toEqual(["local-contrast", "paint-layers"]);
  });

  it("completes verbs for help", async () => {
    expect((await run("help se"))[0]).toEqual(["set"]);
  });

  it("returns nothing for a folder that can't be read", async () => {
    expect((await run("tools nowhere/"))[0]).toEqual([]);
  });
});
