import { describe, expect, it } from "vitest";
import { GLOBAL_OPTIONS } from "./args";
import { complete } from "./complete";
import type { DirEntry, PromptContextInput } from "./prompt/context";
import { context } from "./prompt/test-fixtures";

const FILES: Record<string, DirEntry[]> = {
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

/** Outside a project: names come from the folder listing. */
const loose = (over: Partial<PromptContextInput> = {}) => context({ photos: null, dir: (abs) => FILES[abs], ...over });

const texts = (line: string, ctx = context(), cursor = line.length) => complete(line, cursor, ctx).items.map((c) => c.text);

describe("complete", () => {
  it("completes verbs and built-ins in the first word", () => {
    const got = complete("e", 1, context());
    expect(got.typed).toBe("e");
    expect(got.items.map((c) => c.text)).toEqual(["export", "exit"]);
    expect(got.items[0].detail).toBe("Renders photos.");
  });

  it("accepts a leading safelight", () => {
    expect(texts("safelight to")).toEqual(["tools"]);
  });

  it("completes the verb's options and the global ones", () => {
    expect(texts("tools --a")).toEqual(["--all"]);
    const all = texts("set --");
    for (const g of GLOBAL_OPTIONS) expect(all).toContain(`--${g.name}`);
  });

  it("completes photos and folders from the project, folders first", () => {
    expect(texts("tools ")).toEqual(["Italy/", "\"My Shoot/", "DSC_0412.NEF", "DSC_0413.NEF", "DSC_0419.NEF"]);
    expect(texts("tools DSC_041")).toEqual(["DSC_0412.NEF", "DSC_0413.NEF", "DSC_0419.NEF"]);
    expect(texts("tools Italy/")).toEqual(["Italy/IMG_1.ARW"]);
    expect(complete("tools DSC_0412", 14, context()).items[0].detail).toContain("★★★★·");
  });

  it("completes from the folder listing outside a project, favouring photo files", () => {
    expect(texts("tools ", loose())).toEqual(["Italy/", "\"My Shoot/", "IMG_1.ARW", "IMG_2.ARW"]);
    expect(texts("tools no", loose())).toEqual(["notes.txt"]);
    expect(texts("tools .", loose())).toEqual([".hidden/"]);
  });

  it("quotes names with spaces and keeps the typed folder", () => {
    const got = complete("tools \"My Shoot/", 16, loose());
    expect(got.items.map((c) => c.text)).toEqual(["\"My Shoot/A 1.NEF\"", "\"My Shoot/b.NEF\""]);
    expect(got.start).toBe(6);
  });

  it("completes only folders for cd", () => {
    expect(texts("cd ", loose())).toEqual(["Italy/", "\"My Shoot/"]);
  });

  it("matches without regard to case on Windows and keeps what was typed", () => {
    expect(texts("tools img_1", loose({ platform: "win32", cwd: "C:\\work", dir: (abs) => (abs === "C:\\work" ? FILES["/work"] : undefined) }))).toEqual(["img_1.ARW"]);
  });

  it("offers keys with their current values on set, before or after a photo", () => {
    expect(texts("set DSC_0412.NEF ex")).toEqual(["exposure="]);
    expect(texts("set ex")).toEqual(["exposure="]);
    const got = complete("set DSC_0412.NEF ex", 19, context());
    expect(got.items[0].detail).toBe("+0.50 EV   Basic");
  });

  it("offers keys for get and reset only after a photo", () => {
    expect(texts("get DSC_0412.NEF co")).toEqual(["contrast"]);
    expect(texts("reset DSC_0412.NEF t")).toEqual(["temperature"]);
    expect(texts("get co")).toEqual([]);
  });

  it("offers a choice key's words after =", () => {
    const got = complete("set x.NEF uprightMode=l", 23, context());
    expect(got.items.map((c) => c.text)).toEqual(["level"]);
    expect(got.start).toBe(22);
  });

  it("offers a verb's own words after its photos", () => {
    expect(texts("flag DSC_0412.NEF ")).toEqual(expect.arrayContaining(["pick", "reject", "none", "DSC_0413.NEF"]));
    expect(texts("flag DSC_0412.NEF p")).toEqual(["pick"]);
    expect(texts("rate DSC_0412.NEF 4")).toEqual(["4"]);
  });

  it("completes installed extension names and verbs for help", () => {
    expect(texts("uninstall l")).toEqual(["local-contrast"]);
    expect(texts("help se")).toEqual(["set", "search"]);
  });

  it("returns nothing for a folder not read yet", () => {
    expect(texts("cd nowhere/", loose())).toEqual([]);
  });
});
