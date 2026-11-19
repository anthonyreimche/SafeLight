import { describe, expect, it } from "vitest";
import type { PromptContextInput } from "./context";
import { drain, emptyEditor, reduce, viewOf, type EditorState } from "./editor";
import { footerFor } from "./footer";
import { ghostFor } from "./ghost";
import { highlight } from "./highlight";
import type { Key } from "./keys";
import { menuAt } from "./menu";
import { context, DISK, EXPOSURE, LIBRARY } from "./test-fixtures";

const OPEN = { rels: ["DSC_0412.NEF", "DSC_0413.NEF", "Italy/IMG_1.ARW"], at: 0 };
const shut = (over: Partial<PromptContextInput> = {}) => context({ commands: LIBRARY, dir: (abs) => DISK[abs] ?? [], ...over });
const opened = (over: Partial<PromptContextInput> = {}) => shut({ working: OPEN, ...over });

function runs(line: string, ctx = shut(), cursor = line.length): string[] {
  return highlight(line, cursor, ctx)
    .filter((t) => !(t.kind === "plain" && line.slice(t.start, t.end).trim() === ""))
    .map((t) => `${line.slice(t.start, t.end)}:${t.kind}`);
}
const footer = (line: string, ctx = shut(), cursor = line.length) => footerFor(line, cursor, ctx);
const ghost = (line: string, ctx = shut()) => ghostFor(line, line.length, ctx);

const k = (name: string): Key => ({ kind: "key", name, ctrl: false, alt: false, shift: false });
const at = (line: string): EditorState => ({ ...emptyEditor(), line, cursor: line.length });
const press = (state: EditorState, key: Key, ctx = shut()) => reduce(state, key, ctx, { interactive: true });

const CURRENT = { kind: "photo", name: "DSC_0412.NEF", rating: 4, flag: "pick", step: { at: 4, of: 6 } };

describe("@ and @all", () => {
  it("are photos when a set is open, and missing when none is", () => {
    expect(runs("set @ exposure=1", opened())).toContain("@:photo");
    expect(runs("set @all exposure=1", opened())).toContain("@all:photo");
    expect(runs("set @ exposure=1")).toContain("@:photo-missing");
    expect(runs("set @all exposure=1")).toContain("@all:photo-missing");
    expect(runs("set @a", opened())).toContain("@a:plain");
  });

  it("describe the current photo and the whole set", () => {
    expect(footer("set @", opened())).toEqual(CURRENT);
    expect(footer("set @all", opened())).toEqual({ kind: "matches", count: 3 });
  });

  it("complete in a photo slot only while a set is open", () => {
    expect(menuAt("set @", 5, opened())?.items.map((i) => i.text)).toEqual(["@", "@all"]);
    expect(menuAt("set @", 5, shut())).toBeNull();
    const taken = press(at("set @a"), k("tab"), opened());
    expect(taken.line).toBe("set @all ");
  });
});

describe("the current photo", () => {
  it("is what a verb naming no photo acts on, with @all offered for the rest", () => {
    expect(footer("set ", opened())).toEqual({ ...CURRENT, target: { open: 3 } });
    expect(footer("rate 3", opened())).toEqual({ ...CURRENT, target: { open: 3 } });
  });

  it("leaves the verb's usage while the verb is typed, a named photo, and verbs that ignore the set", () => {
    expect(footer("se", opened())).toMatchObject({ kind: "verb" });
    expect(footer("set DSC_0413.NEF ", opened())).toMatchObject({ kind: "verb" });
    expect(footer("photos ", opened())).toMatchObject({ kind: "verb" });
    expect(footer("set ")).toMatchObject({ kind: "verb" });
  });

  it("gives a key its slider and ghost at the current photo's value", () => {
    expect(footer("set exposure=", opened())).toEqual({ kind: "slider", info: EXPOSURE, now: 0.5 });
    expect(ghost("set exposure=", opened())).toBe("+0.50");
  });

  it("is the footer of an empty line, with paging", () => {
    expect(footer("", opened())).toEqual({ ...CURRENT, paging: true });
    expect(footer("")).toEqual({ kind: "hints" });
  });
});

describe("the disk listing", () => {
  it("counts a folder's photos, the ones not imported and the files gone, for import and ls", () => {
    expect(footer("import ")).toEqual({ kind: "matches", count: 2, listing: { folder: null, notImported: 1, gone: 2 } });
    expect(footer("ls Italy")).toEqual({ kind: "matches", count: 2, listing: { folder: "Italy", notImported: 1, gone: 0 } });
  });

  it("leaves photos not imported out of what a folder matches for other verbs", () => {
    expect(footer("photos Italy")).toEqual({ kind: "matches", count: 1 });
  });

  it("marks a photo not imported as a photo for open, import and ls, and as missing elsewhere", () => {
    expect(runs("open DSC_0500.NEF")).toContain("DSC_0500.NEF:photo");
    expect(runs("ls DSC_0500.NEF")).toContain("DSC_0500.NEF:photo");
    expect(runs("set DSC_0500.NEF ")).toContain("DSC_0500.NEF:photo-missing");
    expect(footer("set DSC_0500.NEF ", shut(), 16)).toEqual({ kind: "problem", message: "DSC_0500.NEF isn't imported." });
    expect(footer("open DSC_0500.NEF")).toEqual({ kind: "photo", name: "DSC_0500.NEF", rating: 0, flag: "none", notImported: true });
  });

  it("completes new photos", () => {
    expect(press(at("open DSC_05"), k("tab")).line).toBe("open DSC_0500.NEF ");
    expect(menuAt("open Italy/IMG_", 15, shut())?.items.map((i) => i.text)).toEqual(["Italy/IMG_1.ARW", "Italy/IMG_2.ARW"]);
  });
});

describe("ghost", () => {
  it("offers the last error's fix on an empty line, and while it is typed", () => {
    expect(ghost("", shut({ fix: "import DSC_0500.NEF" }))).toBe("import DSC_0500.NEF");
    expect(ghost("imp", shut({ fix: "import DSC_0500.NEF" }))).toBe("ort DSC_0500.NEF");
    expect(ghost("")).toBeNull();
  });

  it("offers the first photo of the last folder ls listed after open", () => {
    expect(ghost("open ", shut({ listed: "" }))).toBe("DSC_0412.NEF");
    expect(ghost("open ", shut({ listed: "Italy" }))).toBe("Italy/IMG_1.ARW");
    expect(ghost("open ")).toBeNull();
  });
});

describe("enter and keys", () => {
  it("asks for no photo when a set is open", () => {
    const [events, rest] = drain(press(at("set exposure=1"), k("enter"), opened()));
    expect(events).toEqual([{ kind: "submit", line: "set exposure=1" }]);
    expect(rest.picker).toBeNull();
    expect(press(at("set exposure=1"), k("enter")).picker?.purpose).toBe("photo");
  });

  it("opens the photo picker for open with nothing, new photos marked", () => {
    const picker = press(at("open"), k("enter")).picker;
    expect(picker?.purpose).toBe("photo");
    expect(picker?.all.find((c) => c.label === "DSC_0500.NEF")?.detail).toBe("not imported");
    expect(drain(press(at("open"), k("enter"), opened()))[0]).toEqual([{ kind: "submit", line: "open" }]);
  });

  it("runs next and prev with PageDown and PageUp on an empty line while a set is open", () => {
    expect(drain(press(emptyEditor(), k("pagedown"), opened()))[0]).toEqual([{ kind: "submit", line: "next" }]);
    expect(drain(press(emptyEditor(), k("pageup"), opened()))[0]).toEqual([{ kind: "submit", line: "prev" }]);
    expect(drain(press(emptyEditor(), k("pagedown")))[0]).toEqual([]);
    expect(drain(press(at("set"), k("pagedown"), opened()))[0]).toEqual([]);
  });

  it("knows next, prev and close", () => {
    expect(runs("next 5", opened())).toEqual(["next:verb", "5:value"]);
    expect(runs("close", opened())).toEqual(["close:verb"]);
  });
});

describe("view", () => {
  it("carries the open photo, the folder inside the project and whether Safelight has it", () => {
    const view = viewOf(emptyEditor(), opened({ root: "/", readOnly: true }));
    expect(view.open).toEqual({ name: "DSC_0412", at: 1, of: 3 });
    expect(view.folder).toBe("work");
    expect(view.readOnly).toBe(true);
    const plain = viewOf(emptyEditor(), shut({ root: "/work" }));
    expect(plain.open).toBeUndefined();
    expect(plain.folder).toBeUndefined();
    expect(plain.readOnly).toBeUndefined();
  });
});
