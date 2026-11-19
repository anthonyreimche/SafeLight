// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it } from "vitest";
import type { FooterView, MenuItem, PromptView, Token, TokenKind } from "../prompt/view";
import { EXPOSURE, TEMPERATURE, richOptions, untag } from "./fixtures";
import { renderPromptArea } from "./prompt-render";
import type { OutputOptions } from "./types";
import { cells } from "./width";

const view = (more: Partial<PromptView> = {}): PromptView => ({
  projectName: "Iceland 2026", line: "", cursor: 0, tokens: [], ghost: null, footer: { kind: "hints" }, menu: null, picker: null, ...more,
});

/** Tokens for a line, from "kind:text" words in order. */
function typed(...words: string[]): Pick<PromptView, "line" | "tokens" | "cursor"> {
  let line = "";
  const tokens: Token[] = [];
  for (const word of words) {
    const at = word.indexOf(":");
    const text = word.slice(at + 1);
    if (at > 0) tokens.push({ start: line.length, end: line.length + text.length, kind: word.slice(0, at) as TokenKind });
    line += text;
  }
  return { line, tokens, cursor: line.length };
}

const opts = richOptions(96);
const PROMPT = "‹muted›Iceland 2026‹/› ‹amber››‹/› ";
const footerOf = (footer: FooterView, options: OutputOptions = opts, now?: number): string => renderPromptArea(view({ footer }), options, now).rows[1];

describe("the prompt line", () => {
  it("is the project's name, an amber mark, and the cursor after them", () => {
    expect(renderPromptArea(view(), opts)).toEqual({
      rows: [PROMPT, "  tab ‹muted›commands‹/›‹faint› · ‹/›↑ ‹muted›history‹/›‹faint› · ‹/›ctrl+d ‹muted›leave‹/›"],
      cursorRow: 0,
      cursorCol: 15,
    });
    expect(untag(renderPromptArea(view({ projectName: null }), opts).rows[0])).toBe("safelight › ");
  });

  it("colours every kind of token", () => {
    const look: Record<TokenKind, string> = {
      verb: "‹strong›set‹/›",
      "verb-unknown": "‹invalid›set‹/›",
      photo: "‹path›set‹/›",
      "photo-missing": "‹invalid›set‹/›",
      glob: "set",
      key: "‹amber›set‹/›",
      operator: "‹faint›set‹/›",
      value: "‹strong›set‹/›",
      "value-past": "‹past›set‹/›",
      "value-wrong": "‹invalid›set‹/›",
      unit: "‹muted›set‹/›",
      option: "‹muted›set‹/›",
      quoted: "‹italic›set‹/›",
      plain: "set",
    };
    for (const kind of Object.keys(look) as TokenKind[]) {
      expect(renderPromptArea(view(typed(`${kind}:set`)), opts).rows[0]).toBe(PROMPT + look[kind]);
    }
  });

  it("paints a whole line, leaving what no token covers plain", () => {
    const frame = renderPromptArea(view(typed("verb:set", " ", "photo:DSC_0412.NEF", " ", "key:exposure", "operator:=", "value:+0.7", " ", "key:temperature", "operator:=", "value:5600", "unit:K", " ", "option:--preview")), opts);
    expect(frame.rows[0]).toBe(
      `${PROMPT}‹strong›set‹/› ‹path›DSC_0412.NEF‹/› ‹amber›exposure‹/›‹faint›=‹/›‹strong›+0.7‹/› ‹amber›temperature‹/›‹faint›=‹/›‹strong›5600‹/›‹muted›K‹/› ‹muted›--preview‹/›`,
    );
    expect(frame.cursorCol).toBe(15 + 58);
  });

  it("draws ghost text faint after the line, with the cursor before it", () => {
    const frame = renderPromptArea(view({ ...typed("verb:se"), ghost: "t DSC_0412.NEF" }), opts);
    expect(frame.rows[0]).toBe(`${PROMPT}‹strong›se‹/›‹faint›t DSC_0412.NEF‹/›`);
    expect(frame.cursorCol).toBe(17);
  });

  it("puts the cursor where it is in the line, not at its end", () => {
    const frame = renderPromptArea(view({ ...typed("verb:set", " ", "photo:DSC_0412.NEF"), cursor: 4 }), opts);
    expect([frame.cursorRow, frame.cursorCol]).toEqual([0, 19]);
  });

  it("counts wide characters as two cells", () => {
    const frame = renderPromptArea(view(typed("verb:set", " ", "photo:写真.NEF")), opts);
    expect(frame.cursorCol).toBe(15 + 4 + 8);
  });

  it("wraps a long line at the terminal's edge and follows the cursor onto the next row", () => {
    const narrow = richOptions(40);
    const frame = renderPromptArea(view(typed("verb:set", " ", "photo:DSC_0412.NEF", " ", "key:exposure", "operator:=", "value:+0.7", " ", "key:highlights", "operator:=", "value:-40")), narrow);
    expect(frame.rows.slice(0, 2).map(untag)).toEqual(["Iceland 2026 › set DSC_0412.NEF exposure", "=+0.7 highlights=-40"]);
    expect(frame.rows[0]).toBe(`${PROMPT}‹strong›set‹/› ‹path›DSC_0412.NEF‹/› ‹amber›exposure‹/›`);
    expect([frame.cursorRow, frame.cursorCol]).toEqual([1, 20]);
    expect(frame.rows).toHaveLength(3);
  });

  it("starts a new row when the cursor sits exactly at the edge", () => {
    const frame = renderPromptArea(view({ projectName: "p", ...typed(`plain:${"x".repeat(36)}`) }), richOptions(40));
    expect(frame.rows.slice(0, 2).map(untag)).toEqual([`p › ${"x".repeat(36)}`, ""]);
    expect([frame.cursorRow, frame.cursorCol]).toEqual([1, 0]);
  });

  it("uses the terminal's full width for the line, past the 96 columns the rest keeps to", () => {
    const frame = renderPromptArea(view(typed(`plain:${"x".repeat(150)}`)), richOptions(200));
    expect(frame.cursorRow).toBe(0);
    expect(frame.cursorCol).toBe(165);
  });

  it("cuts a long project name", () => {
    expect(untag(renderPromptArea(view({ projectName: "A project with a very long name indeed" }), opts).rows[0])).toBe("A project with a very l… › ");
  });

  it("carries the folder inside the project, muted like the name", () => {
    const frame = renderPromptArea({ ...view(), folder: "Day 2" }, opts);
    expect(frame.rows[0]).toBe("‹muted›Iceland 2026/Day 2‹/› ‹amber››‹/› ");
    expect(frame.cursorCol).toBe(21);
    expect(untag(renderPromptArea({ ...view(), folder: "2026/Trips/Iceland/Day 2 Golden Circle/Drone" }, opts).rows[0]))
      .toBe("Iceland 2026/…y 2 Golden Circle/Drone › ");
  });

  it("names the photo that is open, strong, with its place among several", () => {
    expect(renderPromptArea({ ...view(), open: { name: "DSC_0412", at: 1, of: 1 } }, opts).rows[0])
      .toBe("‹muted›Iceland 2026‹/› ‹faint››‹/› ‹strong›DSC_0412‹/› ‹amber››‹/› ");
    const several = renderPromptArea({ ...view(typed("verb:set")), open: { name: "DSC_0412", at: 2, of: 3 } }, opts);
    expect(several.rows[0]).toBe("‹muted›Iceland 2026‹/› ‹faint››‹/› ‹strong›DSC_0412‹/›‹muted› 2/3‹/› ‹amber››‹/› ‹strong›set‹/›");
    expect(several.cursorCol).toBe(33);
    expect(untag(renderPromptArea({ ...view(), open: { of: 3 } }, opts).rows[0])).toBe("Iceland 2026 › 3 photos › ");
    expect(untag(renderPromptArea({ ...view(), open: { of: 1 } }, opts).rows[0])).toBe("Iceland 2026 › 1 photo › ");
  });

  it("wears the read only pill before the mark while Safelight has the project open", () => {
    const frame = renderPromptArea({ ...view(), folder: "Day 2", open: { name: "DSC_0412", at: 2, of: 3 }, readOnly: true }, opts);
    expect(frame.rows[0]).toBe("‹muted›Iceland 2026/Day 2‹/› ‹faint››‹/› ‹strong›DSC_0412‹/›‹muted› 2/3‹/› ‹pill.amber› read only ‹/› ‹amber››‹/› ");
    expect(frame.cursorCol).toBe(cells(frame.rows[0]));
    expect(renderPromptArea({ ...view(), readOnly: true }, opts).rows[0]).toBe("‹muted›Iceland 2026‹/› ‹pill.amber› read only ‹/› ‹amber››‹/› ");
  });

  it("gives up the folder under 60 columns, then the count", () => {
    const place = { ...view(), folder: "Day 2", open: { name: "DSC_0412", at: 2, of: 3 }, readOnly: true };
    expect(untag(renderPromptArea(place, richOptions(59)).rows[0])).toBe("Iceland 2026 › DSC_0412 2/3  read only  › ");
    expect(untag(renderPromptArea(place, richOptions(47)).rows[0])).toBe("Iceland 2026 › DSC_0412  read only  › ");
  });

  it("draws the same places without a look: ASCII marks, no colour", () => {
    const bare: OutputOptions = { colour: { stdout: false, stderr: false }, unicode: false, width: 80, verbosity: "normal" };
    expect(renderPromptArea({ ...view(), folder: "Day 2", open: { name: "DSC_0412", at: 2, of: 3 }, readOnly: true }, bare).rows[0])
      .toBe("\x1b[2mIceland 2026/Day 2\x1b[22m \x1b[2m>\x1b[22m \x1b[1mDSC_0412\x1b[22m\x1b[2m 2/3\x1b[22m \x1b[1;7m read only \x1b[22;27m > ");
  });

  it("tolerates tokens that overlap or run past the line", () => {
    const frame = renderPromptArea(view({ line: "set x", cursor: 5, tokens: [{ start: 0, end: 3, kind: "verb" }, { start: 2, end: 99, kind: "key" }] }), opts);
    expect(frame.rows[0]).toBe(`${PROMPT}‹strong›set‹/›‹amber› x‹/›`);
  });
});

describe("the footer", () => {
  it("shows a verb's usage in prompt colours and what it does", () => {
    expect(footerOf({ kind: "verb", usage: "set <photos> key=value…", summary: "Sets values" }))
      .toBe("  ‹strong›set‹/› ‹italic›<photos>‹/› ‹amber›key‹/›‹faint›=‹/›‹strong›value…‹/›   ‹muted›Sets values‹/›");
  });

  it("shows a photo with its stars, flag and step", () => {
    expect(footerOf({ kind: "photo", name: "DSC_0412.NEF", rating: 4, flag: "pick", step: { at: 4, of: 6 } }))
      .toBe("  DSC_0412.NEF‹faint› · ‹/›‹star›★★★★‹/›‹faint›·‹/›‹faint› · ‹/›pick‹faint› · ‹/›‹muted›step 4 of 6‹/›");
    expect(untag(footerOf({ kind: "photo", name: "DSC_0413.NEF", rating: 0, flag: "none" }))).toBe("  DSC_0413.NEF · ·····");
  });

  it("says which open photo a verb with no photo acts on, and how to reach the rest", () => {
    const photo = { kind: "photo" as const, name: "DSC_0412.NEF", rating: 4, flag: "pick" as const };
    expect(footerOf({ ...photo, target: { open: 3 } })).toBe("  ‹faint›→‹/› DSC_0412.NEF‹faint› · ‹/›‹muted›@all for the 3 open‹/›");
    expect(footerOf({ ...photo, target: { open: 1 } })).toBe("  ‹faint›→‹/› DSC_0412.NEF");
  });

  it("offers the next photo on an empty line, and says when a photo isn't imported", () => {
    const photo = { kind: "photo" as const, name: "DSC_0412.NEF", rating: 4, flag: "pick" as const, step: { at: 4, of: 6 } };
    expect(untag(footerOf({ ...photo, paging: true }))).toBe("  DSC_0412.NEF · ★★★★· · pick · step 4 of 6 · pgdn next");
    expect(footerOf({ kind: "photo", name: "DSC_0500.NEF", rating: 0, flag: "none", notImported: true })).toBe("  DSC_0500.NEF‹faint› · ‹/›‹muted›○ not imported‹/›");
  });

  it("counts what a folder holds on disk, for import and ls", () => {
    expect(footerOf({ kind: "matches", count: 412, listing: { folder: null, notImported: 12, gone: 2 } }))
      .toBe("  ‹muted›412 photos here‹/›‹faint› · ‹/›‹amber›12 not imported‹/›‹faint› · ‹/›‹muted›2 files gone‹/›");
    expect(untag(footerOf({ kind: "matches", count: 180, listing: { folder: "Day 2", notImported: 2, gone: 0 } }))).toBe("  Day 2 · 180 photos · 2 not imported");
    expect(untag(footerOf({ kind: "matches", count: 1, listing: { folder: null, notImported: 0, gone: 1 } }))).toBe("  1 photo here · 1 file gone");
  });

  it("counts what a glob matches", () => {
    expect(footerOf({ kind: "matches", count: 38 })).toBe("  ‹muted›38 photos match‹/›");
    expect(footerOf({ kind: "matches", count: 1 })).toBe("  ‹muted›1 photo matches‹/›");
    expect(footerOf({ kind: "matches", count: 0 })).toBe("  ‹amber›!‹/› No photos match");
  });

  it("draws the slider where the value is now", () => {
    expect(footerOf({ kind: "slider", info: EXPOSURE, now: 1.5 }))
      .toBe("  exposure   ‹muted›−5…5 EV‹/›   ‹faint›──────────‹/›‹muted›┼‹/›‹amber›━━●‹/›‹faint›───────‹/›   ‹muted›now‹/› ‹strong›+1.50‹/›");
  });

  it("moves the slider as a number is typed: hollow where it was, solid where it will be", () => {
    expect(footerOf({ kind: "slider", info: EXPOSURE, now: 1.5, next: 3 }))
      .toBe("  exposure   ‹muted›−5…5 EV‹/›   ‹faint›──────────‹/›‹muted›┼‹/›‹amberDim›━━○‹/›‹amber›━━●‹/›‹faint›────‹/›   ‹muted›+1.50‹/› ‹faint›→‹/› ‹strong›+3.00‹/›");
    expect(untag(footerOf({ kind: "slider", info: TEMPERATURE, now: 5150, next: 5600 }))).toBe("  temperature   2000…50000 K   ─────○●──────────────   5150 → 5600");
  });

  it("narrows the slider with the terminal and drops it when there is no room", () => {
    expect(untag(footerOf({ kind: "slider", info: EXPOSURE, now: 1.5 }, richOptions(80)))).toBe("  exposure   −5…5 EV   ────────┼╸●─────   now +1.50");
    expect(untag(footerOf({ kind: "slider", info: EXPOSURE, now: 1.5 }, richOptions(44)))).toBe("  exposure   −5…5 EV   now +1.50");
  });

  it("says where a value past its range will stop", () => {
    expect(footerOf({ kind: "stops", info: EXPOSURE, limit: 5 })).toBe("  exposure ‹muted›stops at‹/› ‹amber›+5.00 EV‹/›");
  });

  it("marks a problem in lamp red and offers the fix", () => {
    expect(footerOf({ kind: "problem", message: '"expsure" isn\'t a value. Did you mean exposure?', fix: "exposure=" }))
      .toBe('  ‹lamp›✕‹/› "expsure" isn\'t a value. Did you mean exposure?‹muted›   tab fixes it‹/›');
    expect(footerOf({ kind: "problem", message: "That photo isn't in this project." })).toBe("  ‹lamp›✕‹/› That photo isn't in this project.");
  });

  it("shows the lamp and the time while a command runs", () => {
    expect(footerOf({ kind: "running", label: "Rendering DSC_0412.NEF", startedAt: 1000 }, opts, 2400))
      .toBe("  ‹lamp›●‹/› Rendering DSC_0412.NEF…  ‹muted›1.4 s‹/›‹faint› · ‹/›‹muted›ctrl+c stops‹/›");
    expect(untag(footerOf({ kind: "running", label: "Rendering", startedAt: 1000 }, opts, 1200))).toBe("  ● Rendering… · ctrl+c stops");
  });

  it("shows what just finished", () => {
    expect(footerOf({ kind: "done", message: "Copied settings from DSC_0412.NEF", ok: true })).toBe("  ‹ok›✓‹/› Copied settings from DSC_0412.NEF");
    expect(footerOf({ kind: "done", message: "exposure was set to 5 EV.", ok: false })).toBe("  ‹amber›!‹/› exposure was set to 5 EV.");
  });

  it("stays on one line at any width", () => {
    const footers: FooterView[] = [
      { kind: "hints" },
      { kind: "verb", usage: "export [photos…] [-o folder] [--format jpg|png|tiff]", summary: "Renders photos to files, with the look each photo has now." },
      { kind: "photo", name: `${"deep/".repeat(20)}DSC_0412.NEF`, rating: 5, flag: "reject", step: { at: 12, of: 40 } },
      { kind: "matches", count: 12_000 },
      { kind: "slider", info: TEMPERATURE, now: 5150, next: 48_000 },
      { kind: "stops", info: TEMPERATURE, limit: 50_000 },
      { kind: "problem", message: "word ".repeat(40), fix: "x" },
      { kind: "running", label: "Rendering ".repeat(12), startedAt: 0 },
      { kind: "done", message: "word ".repeat(40), ok: true },
    ];
    for (const width of [40, 50, 72, 96, 160]) {
      for (const footer of footers) {
        const frame = renderPromptArea(view({ footer }), richOptions(width), 99_000);
        expect(frame.rows).toHaveLength(2);
        expect(cells(frame.rows[1]), `${footer.kind} at ${width}`).toBeLessThan(width);
      }
    }
  });
});

describe("the menu", () => {
  const items: MenuItem[] = [
    { label: "exposure", detail: "+0.50 EV", group: "Basic" },
    { label: "export", detail: "Renders photos" },
    ...Array.from({ length: 10 }, (_, i) => ({ label: `extra${i}`, detail: `value ${i}` })),
  ];
  const menu = (selected: number, rows = 6, list = items): string[] =>
    renderPromptArea(view({ ...typed("verb:set", " ", "plain:ex"), menu: { items: list, selected, rows } }), opts).rows.slice(1);

  it("opens under the line in place of the footer, with a bar on the selection and keys beneath", () => {
    expect(menu(0, 6, items.slice(0, 2))).toEqual([
      "  ‹amber›▌‹/›‹strong›exposure‹/›   ‹muted›+0.50 EV   Basic‹/›",
      "   export     ‹muted›Renders photos‹/›",
      "  ↑↓ ‹muted›move‹/›‹faint› · ‹/›tab ‹muted›next‹/›‹faint› · ‹/›enter ‹muted›take‹/›‹faint› · ‹/›esc ‹muted›close‹/›",
    ]);
  });

  it("shows at most six rows and scrolls to keep the selection in view", () => {
    const labels = (selected: number, rows = 6): string[] => menu(selected, rows).slice(0, -1).map((row) => untag(row).trim().split(/\s+/)[0]);
    expect(labels(0)).toEqual(["▌exposure", "export", "extra0", "extra1", "extra2", "extra3"]);
    expect(labels(2)).toEqual(["exposure", "export", "▌extra0", "extra1", "extra2", "extra3"]);
    expect(labels(5)).toEqual(["extra1", "extra2", "▌extra3", "extra4", "extra5", "extra6"]);
    expect(labels(11)).toEqual(["extra4", "extra5", "extra6", "extra7", "extra8", "▌extra9"]);
    expect(labels(5, 40)).toHaveLength(6);
    expect(labels(5, 3)).toEqual(["extra2", "▌extra3", "extra4"]);
  });

  it("keeps the cursor on the typed line, and falls back to the footer when it has nothing to list", () => {
    const frame = renderPromptArea(view({ ...typed("verb:set", " ", "plain:ex"), menu: { items, selected: 3, rows: 6 } }), opts);
    expect([frame.cursorRow, frame.cursorCol]).toEqual([0, 21]);
    expect(frame.rows).toHaveLength(8);
    expect(renderPromptArea(view({ menu: { items: [], selected: 0, rows: 6 } }), opts).rows).toHaveLength(2);
  });

  it("cuts long rows to the width", () => {
    const long = [{ label: "x".repeat(80), detail: "y".repeat(200), group: "z".repeat(50) }];
    for (const width of [40, 72, 96]) {
      for (const row of renderPromptArea(view({ menu: { items: long, selected: 0, rows: 6 } }), richOptions(width)).rows.slice(1)) {
        expect(cells(row)).toBeLessThan(width);
      }
    }
  });
});

describe("the picker", () => {
  const photos: MenuItem[] = Array.from({ length: 20 }, (_, i) => ({ label: `DSC_04${String(i + 10)}.NEF`, detail: i % 2 ? "★★★★· pick" : "reject" }));
  const picker = (more: Partial<NonNullable<PromptView["picker"]>> = {}, options = opts) => renderPromptArea(view({
    ...typed("verb:tools"),
    picker: { title: "Choose a photo", query: "041", items: photos, selected: 2, rows: 8, empty: "No photos match.", ...more },
  }), options);

  it("is an amber panel under the line: the query, the list, the keys", () => {
    const frame = picker({ items: photos.slice(0, 3), selected: 0 });
    expect(frame.rows.slice(1).map(untag)).toEqual([
      "  ╭─ Choose a photo ──────────────────────────────── 1 of 3 ─╮",
      "  │ › 041                                                    │",
      "  │                                                          │",
      "  │ ▌DSC_0410.NEF   reject                                   │",
      "  │  DSC_0411.NEF   ★★★★· pick                               │",
      "  │  DSC_0412.NEF   reject                                   │",
      "  ╰──────────────────────────────────────────────────────────╯",
      "  ↑↓ move · enter choose · esc back · type to filter",
    ]);
    expect(frame.rows[1].startsWith("  ‹amber›╭‹/›")).toBe(true);
  });

  it("puts the cursor after the query, inside the panel", () => {
    const frame = picker();
    expect([frame.cursorRow, frame.cursorCol]).toEqual([2, 9]);
    expect(picker({ query: "" }).cursorCol).toBe(6);
  });

  it("marks the selection with a bar and the matched letters in amber", () => {
    const frame = picker({ items: photos.slice(0, 3), selected: 1 });
    expect(frame.rows[4]).toContain(" DSC_‹amber›041‹/›0.NEF   ‹muted›reject‹/›");
    expect(frame.rows[5]).toContain("‹amber›▌‹/›‹strong›DSC_‹/›‹amber›041‹/›‹strong›1.NEF‹/›   ‹muted›★★★★· pick‹/›");
    expect(picker({ items: photos.slice(0, 1), query: "dn", selected: 0 }).rows[4]).toContain("‹amber›D‹/›‹strong›SC_0410.‹/›‹amber›N‹/›‹strong›EF‹/›");
    expect(picker({ items: photos.slice(0, 1), query: "zz", selected: 0 }).rows[4]).toContain("‹strong›DSC_0410.NEF‹/›");
  });

  it("shows at most eight rows and scrolls with the selection", () => {
    const listed = (selected: number, rows = 8): string[] =>
      picker({ selected, rows }).rows.slice(4, -2).map((row) => untag(row).replace(/[│▌]/g, "").trim().split(/\s+/)[0]);
    expect(listed(0)).toEqual(["DSC_0410.NEF", "DSC_0411.NEF", "DSC_0412.NEF", "DSC_0413.NEF", "DSC_0414.NEF", "DSC_0415.NEF", "DSC_0416.NEF", "DSC_0417.NEF"]);
    expect(listed(10)[0]).toBe("DSC_0417.NEF");
    expect(listed(10)).toContain("DSC_0420.NEF");
    expect(listed(19)).toEqual(["DSC_0422.NEF", "DSC_0423.NEF", "DSC_0424.NEF", "DSC_0425.NEF", "DSC_0426.NEF", "DSC_0427.NEF", "DSC_0428.NEF", "DSC_0429.NEF"]);
    expect(listed(10, 30)).toHaveLength(8);
    expect(listed(10, 4)).toHaveLength(4);
    expect(untag(picker({ selected: 10 }).rows[1])).toContain("11 of 20");
  });

  it("says so when nothing matches", () => {
    const frame = picker({ items: [], selected: 0, query: "zzz" });
    expect(frame.rows.slice(1, 6).map(untag)).toEqual([
      "  ╭─ Choose a photo ─────────────────────────────────────────╮",
      "  │ › zzz                                                    │",
      "  │                                                          │",
      "  │ No photos match.                                         │",
      "  ╰──────────────────────────────────────────────────────────╯",
    ]);
  });

  it("keeps every row of the panel the same width, down to 40 columns", () => {
    for (const width of [40, 60, 96]) {
      const rows = picker({}, richOptions(width)).rows.slice(1, -1);
      expect(new Set(rows.map(cells)).size).toBe(1);
      expect(cells(rows[0])).toBeLessThan(width);
    }
  });
});

describe("renderPromptArea", () => {
  it("draws without a look in the options: no colour, same shape", () => {
    const bare: OutputOptions = { colour: { stdout: false, stderr: false }, unicode: false, width: 80, verbosity: "normal" };
    const frame = renderPromptArea(view({ ...typed("verb:set", " ", "key:exposure", "operator:=", "value:+0.7"), footer: { kind: "slider", info: EXPOSURE, now: 0.5, next: 0.7 } }), bare);
    expect(frame.rows.map((row) => row.replace(/\x1b\[[0-9;]*m/g, ""))).toEqual([
      "Iceland 2026 > set exposure=+0.7",
      "  exposure   -5...5 EV   [--------.o------]   +0.50 -> +0.70",
    ]);
  });

  it("repaints in well under 8 ms", () => {
    const busy = view({
      ...typed("verb:set", " ", "photo:DSC_0412.NEF", " ", "key:exposure", "operator:=", "value:+0.7", " ", "key:highlights", "operator:=", "value:-40", " ", "option:--preview"),
      ghost: " shadows=+45",
      footer: { kind: "slider", info: EXPOSURE, now: 0.5, next: 0.7 },
      picker: {
        title: "Choose a photo", query: "041", selected: 250, rows: 8, empty: "",
        items: Array.from({ length: 500 }, (_, i) => ({ label: `DSC_${String(i).padStart(4, "0")}.NEF`, detail: "★★★★· pick" })),
      },
    });
    const options = richOptions(120, { tier: "truecolour" });
    for (let i = 0; i < 50; i++) renderPromptArea(busy, options);
    const started = performance.now();
    for (let i = 0; i < 100; i++) renderPromptArea(busy, options);
    expect((performance.now() - started) / 100).toBeLessThan(8);
  });
});
