// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// How the prompt's live area looks: the typed line in colour with its ghost
// text, then one of the footer, the tab menu or a picker. The editor decides
// what every token means; this only draws it. Pure and fast: no file, engine
// or stream is touched, so a keypress repaints at once.

import { COMMAND } from "../types";
import type { FooterView, MenuItem, MenuView, PickerView, PromptFrame, PromptView, TokenKind } from "../prompt/view";
import { barCells, sliderBar } from "./components/bar";
import { keyHints } from "./components/hints";
import type { KeyHint } from "./components/hints";
import { lampLine } from "./components/lamp";
import { stars } from "./components/marks";
import { panel } from "./components/panel";
import { formatRange, valueParts } from "./format";
import { MARGIN, flowDots, lookFor, lookOf, paintCommand } from "./look";
import type { Look } from "./look";
import type { TokenName } from "./theme";
import type { OutputOptions, PromptPlace } from "./types";
import { cells, charCells, clip, clipStart } from "./width";

const TOKEN_LOOK: Record<TokenKind, TokenName> = {
  verb: "strong",
  "verb-unknown": "invalid",
  photo: "path",
  "photo-missing": "invalid",
  glob: "text",
  key: "amber",
  operator: "faint",
  value: "strong",
  "value-past": "past",
  "value-wrong": "invalid",
  unit: "muted",
  option: "muted",
  quoted: "italic",
  plain: "text",
};

const NAME_LIMIT = 24;
const MENU_ROWS = 6;
const PICKER_ROWS = 8;
const PICKER_WIDTH = 60;
const LABEL_LIMIT = 32;
const MIN_COLUMNS = 20;
/** Narrower than these the prompt line gives up its folder, then the working set's count. */
const FOLDER_FROM = 60;
const COUNT_FROM = 48;

const HOME_HINTS: readonly KeyHint[] = [["tab", "commands"], ["↑", "history"], ["ctrl+d", "leave"]];
const MENU_HINTS: readonly KeyHint[] = [["↑↓", "move"], ["tab", "next"], ["enter", "take"], ["esc", "close"]];
const PICKER_HINTS: readonly KeyHint[] = [["↑↓", "move"], ["enter", "choose"], ["esc", "back"], ["type to filter", ""]];

/** The look when the options carry none: no colour, and glyphs by what the console can show. */
function plainLook(opts: OutputOptions): Look {
  return lookOf({
    theme: "unknown", tier: "mono", glyphs: opts.unicode ? "full" : "ascii", motion: "none", clockScale: 1,
    links: false, sync: false, curly: false, rich: { stdout: true, stderr: true },
  }, opts.width);
}

/** The view with its place as the renderer draws it, which also takes a working set that is only a count. */
export type PlacedView = Omit<PromptView, keyof PromptPlace> & PromptPlace;

interface Segment { text: string; token: TokenName; typed?: boolean }

/** Where the prompt is: the project and folder, the working set, and the pill that says writes are refused. */
function placeSegments(view: PlacedView, look: Look, columns: number): Segment[] {
  const { glyphs } = look;
  const name = clip(glyphs.fold(view.projectName ?? COMMAND), NAME_LIMIT, glyphs.ellipsis);
  const folder = view.folder && columns >= FOLDER_FROM ? `/${clipStart(glyphs.fold(view.folder), NAME_LIMIT, glyphs.ellipsis)}` : "";
  const segments: Segment[] = [{ text: name + folder, token: "muted" }];
  const { open } = view;
  if (open) {
    const named = open.name !== undefined;
    const what = named ? clip(glyphs.fold(open.name ?? ""), NAME_LIMIT, glyphs.ellipsis) : `${open.of} ${open.of === 1 ? "photo" : "photos"}`;
    segments.push({ text: " ", token: "text" }, { text: glyphs.prompt, token: "faint" }, { text: " ", token: "text" }, { text: what, token: "strong" });
    if (named && open.of > 1 && open.at !== undefined && columns >= COUNT_FROM) segments.push({ text: ` ${open.at}/${open.of}`, token: "muted" });
  }
  if (view.readOnly) segments.push({ text: " ", token: "text" }, { text: " read only ", token: "pill.amber" });
  return segments;
}

function lineSegments(view: PlacedView, look: Look, columns: number): Segment[] {
  const { glyphs } = look;
  const segments: Segment[] = [
    ...placeSegments(view, look, columns),
    { text: " ", token: "text" },
    { text: glyphs.prompt, token: "amber" },
    { text: " ", token: "text" },
  ];
  let at = 0;
  for (const token of [...view.tokens].sort((a, b) => a.start - b.start)) {
    const start = Math.max(at, Math.min(token.start, view.line.length));
    const end = Math.max(start, Math.min(token.end, view.line.length));
    if (start > at) segments.push({ text: view.line.slice(at, start), token: "text", typed: true });
    if (end > start) segments.push({ text: view.line.slice(start, end), token: TOKEN_LOOK[token.kind], typed: true });
    at = end;
  }
  if (at < view.line.length) segments.push({ text: view.line.slice(at), token: "text", typed: true });
  // The cursor's place is found among typed segments, so an empty line still needs one.
  if (!segments.some((segment) => segment.typed)) segments.push({ text: "", token: "text", typed: true });
  if (view.ghost) segments.push({ text: view.ghost, token: "faint" });
  return segments;
}

interface Laid { rows: string[]; cursorRow: number; cursorCol: number }

/** Wraps the styled line at the terminal's edge and finds where the cursor lands. */
function layLine(view: PlacedView, look: Look, columns: number): Laid {
  const { theme } = look;
  const rows: string[] = [];
  let row = "";
  let col = 0;
  let typed = 0;
  let run = "";
  let token: TokenName = "text";
  const at = { row: -1, col: 0 };
  const flush = (): void => {
    row += theme.paint(token, run);
    run = "";
  };
  const wrap = (): void => {
    flush();
    rows.push(row);
    row = "";
    col = 0;
  };
  const mark = (): void => {
    if (at.row >= 0 || typed < view.cursor) return;
    if (col >= columns) wrap();
    at.row = rows.length;
    at.col = col;
  };

  for (const segment of lineSegments(view, look, columns)) {
    flush();
    token = segment.token;
    for (const char of segment.text) {
      if (segment.typed) mark();
      const size = charCells(char);
      if (col + size > columns) wrap();
      run += char;
      col += size;
      if (segment.typed) typed += char.length;
    }
    if (segment.typed) mark();
  }
  flush();
  rows.push(row);
  return { rows, cursorRow: Math.max(0, at.row), cursorCol: at.col };
}

function sliderFooter(footer: Extract<FooterView, { kind: "slider" }>, look: Look): string {
  const { glyphs, theme } = look;
  const { info } = footer;
  const text = (value: number): string => valueParts(info, value, glyphs).text;
  const unit = info.unit ? ` ${info.unit}` : "";
  const size = barCells(look.columns);
  const bar = size > 0 ? sliderBar({ info, value: footer.next ?? footer.now, was: footer.next === undefined ? undefined : footer.now, cells: size }, look) : "";
  const moved = footer.next === undefined
    ? `${theme.paint("muted", "now")} ${theme.paint("strong", text(footer.now))}`
    : `${theme.paint("muted", text(footer.now))} ${theme.paint("faint", glyphs.arrow)} ${theme.paint("strong", text(footer.next))}`;
  const range = theme.paint("muted", formatRange(info, glyphs) + unit);
  // The range is the first thing to go when the line is too long, then the bar.
  for (const parts of [[info.key, range, bar, moved], [info.key, bar, moved], [info.key, moved]]) {
    const line = parts.filter((part) => part !== "").join("   ");
    if (cells(line) <= look.width) return line;
  }
  return moved;
}

function footerLine(footer: FooterView, look: Look, now: number): string {
  const { glyphs, theme } = look;
  const room = look.width;
  switch (footer.kind) {
    case "hints":
      return keyHints(HOME_HINTS, room, look);
    case "verb": {
      const usage = clip(glyphs.fold(footer.usage), room, glyphs.ellipsis);
      const left = room - cells(usage) - 3;
      return paintCommand(usage, look) + (left >= 12 ? `   ${theme.paint("muted", clip(glyphs.fold(footer.summary), left, glyphs.ellipsis))}` : "");
    }
    case "photo": {
      const name = clip(footer.name, Math.max(12, room - 36), glyphs.ellipsis);
      // A verb that names no photo: which one it acts on, and how to reach the rest.
      if (footer.target) {
        return flowDots([
          `${theme.paint("faint", glyphs.arrow)} ${name}`,
          footer.target.open > 1 ? theme.paint("muted", `@all for the ${footer.target.open} open`) : "",
        ], room, look)[0] ?? "";
      }
      // Only what fits on the one line: the name first, then as many marks as there is room for.
      return flowDots([
        name,
        ...(footer.notImported
          ? [theme.paint("muted", `${glyphs.was} not imported`)]
          : [stars(footer.rating, look), footer.flag === "none" ? "" : footer.flag]),
        footer.step ? theme.paint("muted", `step ${footer.step.at} of ${footer.step.of}`) : "",
        footer.paging ? `pgdn ${theme.paint("muted", "next")}` : "",
      ], room, look)[0] ?? "";
    }
    case "matches":
      if (footer.listing) {
        const { folder, notImported, gone } = footer.listing;
        const count = `${footer.count} ${footer.count === 1 ? "photo" : "photos"}`;
        return flowDots([
          folder === null ? "" : clip(glyphs.fold(folder), Math.max(12, room - 48), glyphs.ellipsis),
          theme.paint("muted", folder === null ? `${count} here` : count),
          notImported > 0 ? theme.paint("amber", `${notImported} not imported`) : "",
          gone > 0 ? theme.paint("muted", `${gone} ${gone === 1 ? "file" : "files"} gone`) : "",
        ], room, look)[0] ?? "";
      }
      return footer.count === 0
        ? `${theme.paint("amber", glyphs.warn)} No photos match`
        : theme.paint("muted", footer.count === 1 ? "1 photo matches" : `${footer.count} photos match`);
    case "slider":
      return sliderFooter(footer, look);
    case "stops": {
      const limit = valueParts(footer.info, footer.limit, glyphs);
      return `${footer.info.key} ${theme.paint("muted", "stops at")} ${theme.paint("amber", limit.text + limit.unit)}`;
    }
    case "problem": {
      const fix = footer.fix ? "   tab fixes it" : "";
      const message = clip(glyphs.fold(footer.message), room - 2 - fix.length, glyphs.ellipsis);
      return `${theme.paint("lamp", glyphs.fail)} ${message}${theme.paint("muted", fix)}`;
    }
    case "running":
      return lampLine(clip(footer.label, room - 30, glyphs.ellipsis), Math.max(0, now - footer.startedAt), look)
        + theme.paint("faint", glyphs.dot) + theme.paint("muted", "ctrl+c stops");
    case "done":
      return `${footer.ok ? theme.paint("ok", glyphs.ok) : theme.paint("amber", glyphs.warn)} ${clip(glyphs.fold(footer.message), room - 3, glyphs.ellipsis)}`;
  }
}

/** The slice of a list that shows, with the selected row kept near the middle. */
function windowOf(count: number, selected: number, rows: number): { from: number; to: number } {
  const size = Math.max(1, Math.min(rows, count));
  const from = Math.max(0, Math.min(selected - Math.floor((size - 1) / 2), count - size));
  return { from, to: from + size };
}

/** Which characters of `label` the query matched, in order; empty when it didn't match at all. */
function matchedAt(label: string, query: string): Set<number> {
  const wanted = [...query.toLowerCase()].filter((char) => char !== " ");
  const found = new Set<number>();
  let next = 0;
  [...label.toLowerCase()].forEach((char, i) => {
    if (next < wanted.length && char === wanted[next]) {
      found.add(i);
      next++;
    }
  });
  return next === wanted.length ? found : new Set();
}

function listRows(items: readonly MenuItem[], selected: number, rows: number, query: string, room: number, look: Look): string[] {
  const { glyphs, theme } = look;
  const { from, to } = windowOf(items.length, selected, rows);
  const shown = items.slice(from, to);
  const labels = shown.map((item) => clip(glyphs.fold(item.label), Math.min(LABEL_LIMIT, room - 2), glyphs.ellipsis));
  const labelWidth = Math.max(0, ...labels.map(cells));
  const detailRoom = room - 1 - labelWidth - 3;

  return shown.map((item, i) => {
    const chosen = from + i === selected;
    const matched = query ? matchedAt(labels[i], query) : new Set<number>();
    const base: TokenName = chosen ? "strong" : "text";
    let label = "";
    let run = "";
    let lit = false;
    [...labels[i], ""].forEach((char, at) => {
      if (matched.has(at) !== lit || char === "") {
        label += theme.paint(lit ? "amber" : base, run);
        run = "";
        lit = matched.has(at);
      }
      run += char;
    });
    const parts = [item.detail ?? "", item.group ?? ""].filter((part) => part !== "").map((part) => glyphs.fold(part));
    const detail = parts.length > 0 && detailRoom >= 8 ? `   ${theme.paint("muted", clip(parts.join("   "), detailRoom, glyphs.ellipsis))}` : "";
    return (chosen ? theme.paint("amber", glyphs.selected) : " ") + label + " ".repeat(labelWidth - cells(labels[i])) + detail;
  });
}

function menuRows(menu: MenuView, look: Look): string[] {
  return [
    ...listRows(menu.items, menu.selected, Math.min(MENU_ROWS, Math.max(1, menu.rows)), "", look.width, look),
    keyHints(MENU_HINTS, look.width, look),
  ];
}

function pickerRows(picker: PickerView, look: Look): { rows: string[]; queryCol: number } {
  const { glyphs, theme } = look;
  const width = Math.min(PICKER_WIDTH, look.width);
  const inner = width - 4;
  const query = clip(picker.query, inner - 3, glyphs.ellipsis);
  const list = picker.items.length === 0
    ? [theme.paint("muted", clip(glyphs.fold(picker.empty), inner, glyphs.ellipsis))]
    : listRows(picker.items, picker.selected, Math.min(PICKER_ROWS, Math.max(1, picker.rows)), picker.query, inner, look);
  const box = panel({
    title: glyphs.fold(picker.title),
    note: picker.items.length > 0 ? theme.paint("muted", `${picker.selected + 1} of ${picker.items.length}`) : undefined,
    body: [`${theme.paint("amber", glyphs.prompt)} ${query}`, "", ...list],
    width,
    tone: "amber",
  }, look);
  return { rows: [...box, keyHints(PICKER_HINTS, look.width, look)], queryCol: 2 + cells(glyphs.prompt) + 1 + cells(query) };
}

/**
 * The prompt's live area as rows, and where the cursor goes in them. `now`
 * only matters to a "running" footer, which shows how long it has been. A
 * view that also says where it is (a folder, photos open, read only) gets
 * that in its prompt line.
 */
export function renderPromptArea(view: PlacedView, opts: OutputOptions, now: number = Date.now()): PromptFrame {
  const look = lookFor(opts, "stdout") ?? plainLook(opts);
  const line = layLine(view, look, Math.max(MIN_COLUMNS, opts.width));
  const pad = " ".repeat(MARGIN);
  const below = (rows: readonly string[]): string[] => rows.map((row) => (row === "" ? "" : pad + row));

  if (view.picker) {
    const picker = pickerRows(view.picker, look);
    return {
      rows: [...line.rows, ...below(picker.rows)],
      cursorRow: line.rows.length + 1,
      cursorCol: MARGIN + picker.queryCol,
    };
  }
  const under = view.menu && view.menu.items.length > 0 ? menuRows(view.menu, look) : [footerLine(view.footer, look, now)];
  return { rows: [...line.rows, ...below(under)], cursorRow: line.cursorRow, cursorCol: line.cursorCol };
}
