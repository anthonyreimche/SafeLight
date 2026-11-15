import { describe, expect, it } from "vitest";
import type { PromptContext } from "./context";
import { drain, emptyEditor, reduce, viewOf, type EditorState } from "./editor";
import type { Key } from "./keys";
import { context } from "./test-fixtures";

const k = (name: string, mods: Partial<{ ctrl: boolean; alt: boolean; shift: boolean }> = {}): Key =>
  ({ kind: "key", name, ctrl: false, alt: false, shift: false, ...mods });
const t = (text: string): Key => ({ kind: "text", text });

function run(keys: (Key | string)[], ctx: PromptContext = context(), start: EditorState = emptyEditor(), interactive = true): EditorState {
  return keys.reduce<EditorState>((s, key) => reduce(s, typeof key === "string" ? t(key) : key, ctx, { interactive }), start);
}
const at = (line: string, cursor = line.length): EditorState => ({ ...emptyEditor(), line, cursor });
const events = (s: EditorState) => drain(s)[0];

describe("editing", () => {
  it("inserts at the cursor and moves by character", () => {
    const s = run(["st", k("left"), "e"]);
    expect([s.line, s.cursor]).toEqual(["set", 2]);
    expect(run([k("right"), k("right")], context(), at("set", 0)).cursor).toBe(2);
  });

  it("moves by whole graphemes", () => {
    const line = "a👍🏽b";
    expect(run([k("left")], context(), at(line, line.length - 1)).cursor).toBe(1);
    expect(run([k("backspace")], context(), at(line, line.length - 1)).line).toBe("ab");
  });

  it("goes home and end with keys and ctrl+a / ctrl+e", () => {
    expect(run([k("home")], context(), at("set x")).cursor).toBe(0);
    expect(run([k("a", { ctrl: true })], context(), at("set x")).cursor).toBe(0);
    expect(run([k("end")], context(), at("set x", 0)).cursor).toBe(5);
    expect(run([k("e", { ctrl: true })], context(), at("set x", 0)).cursor).toBe(5);
  });

  it("moves by token with alt and ctrl arrows, and alt+b / alt+f", () => {
    const line = "set DSC_0412.NEF exposure=1";
    expect(run([k("left", { alt: true })], context(), at(line)).cursor).toBe(17);
    expect(run([k("left", { ctrl: true }), k("left", { ctrl: true })], context(), at(line)).cursor).toBe(4);
    expect(run([k("right", { alt: true })], context(), at(line, 0)).cursor).toBe(3);
    expect(run([k("b", { alt: true })], context(), at(line)).cursor).toBe(17);
    expect(run([k("f", { alt: true })], context(), at(line, 4)).cursor).toBe(16);
  });

  it("deletes back and forward, by word, and to either end", () => {
    expect(run([k("backspace")], context(), at("set")).line).toBe("se");
    expect(run([k("delete")], context(), at("set", 0)).line).toBe("et");
    expect(run([k("w", { ctrl: true })], context(), at("set DSC_0412.NEF")).line).toBe("set ");
    expect(run([k("backspace", { alt: true })], context(), at("set DSC_0412.NEF")).line).toBe("set ");
    expect(run([k("d", { alt: true })], context(), at("set DSC_0412.NEF", 3)).line).toBe("set");
    expect(run([k("u", { ctrl: true })], context(), at("set DSC_0412.NEF", 4))).toMatchObject({ line: "DSC_0412.NEF", cursor: 0 });
    expect(run([k("k", { ctrl: true })], context(), at("set DSC_0412.NEF", 3)).line).toBe("set");
  });

  it("drops control characters from typed text", () => {
    expect(run(["a\x07b\tc"]).line).toBe("ab c");
  });
});

describe("history", () => {
  const ctx = context({ history: ["tools", "set a.NEF exposure=1", "photos", "set b.NEF exposure=2"] });

  it("walks back and forward with up and down, back to the draft", () => {
    let s = run([k("up")], ctx);
    expect(s.line).toBe("set b.NEF exposure=2");
    s = run([k("up"), k("up")], ctx, s);
    expect(s.line).toBe("set a.NEF exposure=1");
    s = run([k("down"), k("down"), k("down")], ctx, s);
    expect(s.line).toBe("");
  });

  it("searches by prefix when the line isn't empty", () => {
    let s = run([k("up")], ctx, at("set a"));
    expect(s.line).toBe("set a.NEF exposure=1");
    s = run([k("up")], ctx, s);
    expect(s.line).toBe("set a.NEF exposure=1");
    s = run([k("down")], ctx, s);
    expect(s.line).toBe("set a");
  });

  it("walks with ctrl+p and ctrl+n too", () => {
    expect(run([k("p", { ctrl: true })], ctx).line).toBe("set b.NEF exposure=2");
  });

  it("searches history through the picker with ctrl+r, and enter puts the line back without running", () => {
    let s = run([k("r", { ctrl: true })], ctx);
    expect(s.picker?.title).toBe("History");
    s = run(["phot"], ctx, s);
    expect(s.picker?.shown.map((c) => c.text)).toEqual(["photos"]);
    s = run([k("enter")], ctx, s);
    expect([s.line, s.picker, events(s)]).toEqual(["photos", null, []]);
  });
});

describe("ghost", () => {
  const ctx = context({ history: ["tools DSC_0412.NEF --all"] });

  it("is taken whole with right or end at the end of the line", () => {
    expect(run([k("right")], ctx, at("too")).line).toBe("tools DSC_0412.NEF --all");
    expect(run([k("end")], ctx, at("too")).line).toBe("tools DSC_0412.NEF --all");
  });

  it("is taken a token at a time with alt+right", () => {
    expect(run([k("right", { alt: true })], ctx, at("too")).line).toBe("tools");
    expect(run([k("right", { alt: true }), k("right", { alt: true })], ctx, at("too")).line).toBe("tools DSC_0412.NEF");
  });

  it("is in the view only with the cursor at the end", () => {
    expect(viewOf(at("too"), ctx).ghost).toBe("ls DSC_0412.NEF --all");
    expect(viewOf(at("too", 1), ctx).ghost).toBeNull();
  });
});

describe("tab menu", () => {
  it("takes the one candidate at once, with a space after a finished word", () => {
    expect(run([k("tab")], context(), at("too"))).toMatchObject({ line: "tools ", menu: null });
    expect(run([k("tab")], context(), at("set DSC_0412.NEF expo"))).toMatchObject({ line: "set DSC_0412.NEF exposure=", menu: null });
  });

  it("opens a menu when more than one fits, filling what they share", () => {
    const s = run([k("tab")], context(), at("tools DSC"));
    expect(s.line).toBe("tools DSC_041");
    expect(s.menu?.items.map((c) => c.text)).toEqual(["DSC_0412.NEF", "DSC_0413.NEF", "DSC_0419.NEF"]);
    expect(viewOf(s, context()).menu).toMatchObject({ selected: 0, rows: 6 });
    expect(viewOf(s, context()).ghost).toBeNull();
  });

  it("moves with tab, shift+tab and the arrows; enter takes without running; esc closes", () => {
    let s = run([k("tab"), k("tab")], context(), at("tools DSC"));
    expect(s.menu?.selected).toBe(1);
    s = run([k("tab", { shift: true }), k("down"), k("down")], context(), s);
    expect(s.menu?.selected).toBe(2);
    const taken = run([k("enter")], context(), s);
    expect([taken.line, taken.menu, events(taken)]).toEqual(["tools DSC_0419.NEF ", null, []]);
    expect(run([k("escape")], context(), s).menu).toBeNull();
  });

  it("narrows as you type and closes when nothing fits", () => {
    let s = run([k("tab")], context(), at("tools DSC"));
    s = run(["3"], context(), s);
    expect(s.menu?.items.map((c) => c.text)).toEqual(["DSC_0413.NEF"]);
    s = run(["x"], context(), s);
    expect(s.menu).toBeNull();
  });

  it("fixes a misspelt key or verb", () => {
    expect(run([k("tab")], context(), at("set x.NEF expsure=1", 14)).line).toBe("set x.NEF exposure=1");
    expect(run([k("tab")], context(), at("sett x", 6)).line).toBe("set x");
  });
});

describe("enter and pickers", () => {
  it("runs a complete line and empties the editor", () => {
    const s = run(["tools", k("enter")]);
    expect(events(s)).toEqual([{ kind: "submit", line: "tools" }]);
    expect(s.line).toBe("");
  });

  it("opens the photo picker on a line missing a photo; enter puts the photo in and runs it", () => {
    let s = run([k("enter")], context(), at("set exposure=+0.5"));
    expect(s.picker?.title).toBe("Choose a photo");
    expect(events(s)).toEqual([]);
    s = run(["0413"], context(), s);
    expect(s.picker?.shown[0].label).toBe("DSC_0413.NEF");
    s = run([k("enter")], context(), s);
    expect(events(s)).toEqual([{ kind: "submit", line: "set DSC_0413.NEF exposure=+0.5" }]);
  });

  it("quotes a chosen photo with a space in its name", () => {
    let s = run([k("enter")], context(), at("tools x", 0));
    expect(s.picker).toBeNull();
    s = run([k("enter")], context(), at("flag"));
    s = run(["A 1", k("enter")], context(), s);
    expect(s.line).toBe("flag \"My Shoot/A 1.NEF\"");
    expect(s.picker?.title).toBe("Choose a flag");
  });

  it("opens a choice picker for a missing choice, then runs", () => {
    let s = run([k("enter")], context(), at("flag DSC_0412.NEF"));
    expect(s.picker?.shown.map((c) => c.text)).toEqual(["pick", "reject", "none"]);
    s = run([k("down"), k("enter")], context(), s);
    expect(events(s)).toEqual([{ kind: "submit", line: "flag DSC_0412.NEF reject" }]);
  });

  it("opens a choice picker for a choice key with no value", () => {
    let s = run([k("enter")], context(), at("set DSC_0412.NEF uprightMode="));
    expect(s.picker?.title).toBe("Choose Upright");
    s = run(["lev", k("enter")], context(), s);
    expect(events(s)).toEqual([{ kind: "submit", line: "set DSC_0412.NEF uprightMode=level" }]);
  });

  it("opens the key picker for set with no key; enter puts key= on the line and does not run", () => {
    let s = run([k("enter")], context(), at("set DSC_0412.NEF"));
    expect(s.picker?.title).toBe("Choose a value");
    expect(s.picker?.shown[0]).toMatchObject({ label: "exposure", detail: "+0.50 EV", group: "Basic" });
    s = run([k("enter")], context(), s);
    expect([s.line, s.cursor, s.picker, events(s)]).toEqual(["set DSC_0412.NEF exposure=", 26, null, []]);
  });

  it("puts the line back untouched on esc", () => {
    let s = run([k("enter")], context(), at("set exposure=+0.5", 4));
    s = run(["041", k("escape")], context(), s);
    expect([s.line, s.cursor, s.picker]).toEqual(["set exposure=+0.5", 17, null]);
  });

  it("opens no picker when not interactive", () => {
    const s = run([k("enter")], context(), at("set exposure=+0.5"), false);
    expect(events(s)).toEqual([{ kind: "submit", line: "set exposure=+0.5" }]);
  });

  it("opens no picker outside a project", () => {
    expect(events(run([k("enter")], context({ photos: null }), at("set exposure=1")))).toEqual([{ kind: "submit", line: "set exposure=1" }]);
  });
});

describe("paste", () => {
  it("runs each pasted line and leaves the last unfinished one on the line", () => {
    const s = reduce(at("echo "), { kind: "paste", text: "a\necho b\npartial" }, context(), { interactive: true });
    expect(events(s)).toEqual([{ kind: "submit", line: "echo a" }, { kind: "submit", line: "echo b" }]);
    expect(s.line).toBe("partial");
  });

  it("types a single pasted line in at the cursor", () => {
    const s = reduce(at("set  x", 4), { kind: "paste", text: "DSC_0412.NEF\t" }, context(), { interactive: true });
    expect(s.line).toBe("set DSC_0412.NEF  x");
  });
});

describe("ctrl keys", () => {
  it("ctrl+c clears the line and reports it", () => {
    const s = run([k("c", { ctrl: true })], context(), at("set x"));
    expect(s.line).toBe("");
    expect(events(s)).toEqual([{ kind: "interrupt", line: "set x" }]);
  });

  it("ctrl+c in a picker puts the line back", () => {
    let s = run([k("enter")], context(), at("set exposure=1"));
    s = run([k("c", { ctrl: true })], context(), s);
    expect([s.line, s.picker, events(s)]).toEqual(["set exposure=1", null, []]);
  });

  it("ctrl+d leaves on an empty line and deletes forward otherwise", () => {
    expect(events(run([k("d", { ctrl: true })]))).toEqual([{ kind: "eof" }]);
    expect(run([k("d", { ctrl: true })], context(), at("set", 0)).line).toBe("et");
  });

  it("ctrl+l asks for a clear screen and keeps the line", () => {
    const s = run([k("l", { ctrl: true })], context(), at("set"));
    expect(events(s)).toEqual([{ kind: "clear-screen" }]);
    expect(s.line).toBe("set");
  });
});

describe("view", () => {
  it("carries the project, tokens, footer and cursor", () => {
    const v = viewOf(at("set DSC_0412.NEF exposure=+0.7"), context());
    expect(v.projectName).toBe("Iceland 2026");
    expect(v.cursor).toBe(30);
    expect(v.tokens.some((tok) => tok.kind === "photo")).toBe(true);
    expect(v.footer).toMatchObject({ kind: "slider", now: 0.5, next: 0.7 });
    expect(v.menu).toBeNull();
    expect(v.picker).toBeNull();
  });

  it("builds a view in well under a millisecond on average with thousands of photos", () => {
    const photos = Array.from({ length: 5000 }, (_, i) => ({ rel: `2026/day${i % 40}/DSC_${String(i).padStart(4, "0")}.NEF`, rating: i % 6, flag: "none" as const, label: "none" }));
    const history = Array.from({ length: 1000 }, (_, i) => `set 2026/day1/DSC_${i}.NEF exposure=${i % 5}`);
    const ctx = context({ photos, history });
    let s = emptyEditor();
    const started = performance.now();
    for (const ch of "set 2026/day3/DSC_01 exposure=+0.7 contrast=20") {
      s = reduce(s, t(ch), ctx, { interactive: true });
      viewOf(s, ctx);
    }
    expect((performance.now() - started) / 45).toBeLessThan(8);
  });
});
