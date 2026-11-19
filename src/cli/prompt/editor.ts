// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The prompt's line editor as a reducer: (state, key) → state. What the
// driver must do (run a line, leave, clear the screen) comes back as events
// on the state; viewOf turns a state into what the renderer draws.

import path from "node:path";
import type { PromptContext } from "./context";
import { footerFor } from "./footer";
import { ghostFor } from "./ghost";
import { analyze } from "./grammar";
import { highlight } from "./highlight";
import type { Key } from "./keys";
import { commonStart, completeAt, menuAt, menuView, takeCandidate, type MenuState } from "./menu";
import { historyPicker, missingPicker, moveSelection, pickerView, placeChoice, withQuery, type PickerState } from "./picker";
import type { PromptView } from "./view";

export type EditorEvent =
  | { kind: "submit"; line: string }
  | { kind: "interrupt"; line: string }
  | { kind: "eof" }
  | { kind: "clear-screen" };

export interface EditorState {
  line: string;
  cursor: number;
  /** Walking history: the entry shown (history.length = the draft), the draft, and the prefix searched for. */
  nav: { at: number; draft: string; prefix: string } | null;
  menu: MenuState | null;
  picker: PickerState | null;
  events: readonly EditorEvent[];
}

export interface ReduceOptions {
  /** Menus and pickers may open: false for keys typed ahead while a command runs, or pasted. */
  interactive: boolean;
}

export const emptyEditor = (): EditorState => ({ line: "", cursor: 0, nav: null, menu: null, picker: null, events: [] });

// ---- text helpers ------------------------------------------------------------------

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function prevBoundary(line: string, at: number): number {
  let last = 0;
  for (const { index } of segmenter.segment(line)) {
    if (index >= at) break;
    last = index;
  }
  return last;
}

function nextBoundary(line: string, at: number): number {
  for (const { index, segment } of segmenter.segment(line)) {
    if (index + segment.length > at) return index + segment.length;
  }
  return line.length;
}

function wordLeft(line: string, at: number): number {
  let i = at;
  while (i > 0 && /\s/.test(line[i - 1])) i--;
  while (i > 0 && !/\s/.test(line[i - 1])) i--;
  return i;
}

function wordRight(line: string, at: number): number {
  let i = at;
  while (i < line.length && /\s/.test(line[i])) i++;
  while (i < line.length && !/\s/.test(line[i])) i++;
  return i;
}

// Control characters can't be typed into the line; a pasted tab becomes a space.
const clean = (text: string): string => text.replace(/\t/g, " ").replace(/[\x00-\x1f\x7f]/g, "");

// ---- edits ---------------------------------------------------------------------------

function edit(state: EditorState, line: string, cursor: number, ctx: PromptContext): EditorState {
  const menu = state.menu ? menuAt(line, cursor, ctx) : null;
  return { ...state, line, cursor, nav: null, menu };
}

const insert = (state: EditorState, text: string, ctx: PromptContext): EditorState =>
  edit(state, state.line.slice(0, state.cursor) + text + state.line.slice(state.cursor), state.cursor + text.length, ctx);

const cut = (state: EditorState, from: number, to: number, ctx: PromptContext): EditorState =>
  from === to ? state : edit(state, state.line.slice(0, from) + state.line.slice(to), from, ctx);

const move = (state: EditorState, cursor: number): EditorState => ({ ...state, cursor, menu: null });

const emit = (state: EditorState, event: EditorEvent): EditorState => ({ ...state, events: [...state.events, event] });

const submit = (state: EditorState, line: string): EditorState =>
  emit({ ...state, line: "", cursor: 0, nav: null, menu: null, picker: null }, { kind: "submit", line });

/** Takes the ghost (all of it, or its first word) when the cursor is at the end. */
function acceptGhost(state: EditorState, ctx: PromptContext, oneWord: boolean): EditorState | null {
  if (state.cursor !== state.line.length) return null;
  const ghost = ghostFor(state.line, state.cursor, ctx);
  if (!ghost) return null;
  const take = oneWord ? (/^\s*\S+/.exec(ghost)?.[0] ?? ghost) : ghost;
  return insert(state, take, ctx);
}

function history(state: EditorState, ctx: PromptContext, by: -1 | 1): EditorState {
  const entries = ctx.history;
  const nav = state.nav ?? { at: entries.length, draft: state.line, prefix: state.line };
  let at = nav.at;
  for (;;) {
    at += by;
    if (at < 0) return state;
    if (at >= entries.length) {
      if (nav.at >= entries.length) return state;
      return { ...state, line: nav.draft, cursor: nav.draft.length, nav: null, menu: null };
    }
    const entry = entries[at];
    if (entry.startsWith(nav.prefix) && entry !== state.line) {
      return { ...state, line: entry, cursor: entry.length, nav: { ...nav, at }, menu: null };
    }
  }
}

function pressTab(state: EditorState, ctx: PromptContext, opts: ReduceOptions): EditorState {
  if (!opts.interactive) return state;
  const analysis = analyze(state.line, state.cursor, ctx);
  const footer = footerFor(state.line, state.cursor, ctx, analysis);
  if (footer.kind === "problem" && footer.fix !== undefined) {
    const bad = analysis.at && analysis.at.role.kind === "assign"
      ? { start: analysis.at.start, end: analysis.at.role.keyEnd }
      : analysis.verb && !analysis.spec && !analysis.builtin ? { start: analysis.verb.start, end: analysis.verb.end } : null;
    if (bad) {
      const line = state.line.slice(0, bad.start) + footer.fix + state.line.slice(bad.end);
      const shift = footer.fix.length - (bad.end - bad.start);
      return edit(state, line, state.cursor >= bad.end ? state.cursor + shift : bad.start + footer.fix.length, ctx);
    }
  }
  const completion = completeAt(state.line, state.cursor, ctx);
  if (completion.items.length === 0) return state;
  if (completion.items.length === 1) {
    const taken = takeCandidate(state.line, completion.start, completion.end, completion.items[0].text);
    return edit(state, taken.line, taken.cursor, ctx);
  }
  const typed = state.line.slice(completion.start, state.cursor);
  const shared = commonStart(completion);
  let next = state;
  if (shared.length > typed.length && shared.startsWith(typed)) {
    const line = state.line.slice(0, completion.start) + shared + state.line.slice(state.cursor);
    next = { ...state, line, cursor: completion.start + shared.length, nav: null };
  }
  return { ...next, menu: menuAt(next.line, next.cursor, ctx) };
}

function pressEnter(state: EditorState, ctx: PromptContext, opts: ReduceOptions): EditorState {
  if (state.menu) {
    const item = state.menu.items[state.menu.selected];
    const taken = takeCandidate(state.line, state.menu.start, state.menu.end, item.text);
    return { ...edit(state, taken.line, taken.cursor, ctx), menu: null };
  }
  const picker = opts.interactive ? missingPicker(state.line, ctx) : null;
  return picker ? { ...state, picker, menu: null, nav: null } : submit(state, state.line);
}

// ---- the picker ------------------------------------------------------------------------

function choose(state: EditorState, picker: PickerState, ctx: PromptContext): EditorState {
  const item = picker.shown[picker.selected];
  if (!item) return state;
  if (picker.purpose === "history") return { ...state, line: item.text, cursor: item.text.length, picker: null, nav: null };
  const { line, cursor } = placeChoice(picker, item);
  if (!picker.run) return { ...state, line, cursor, picker: null, nav: null };
  const next = missingPicker(line, ctx);
  return next ? { ...state, line, cursor, picker: next } : submit(state, line);
}

function pickerKey(state: EditorState, picker: PickerState, key: Key, ctx: PromptContext): EditorState {
  const restore = (): EditorState => ({ ...state, line: picker.saved.line, cursor: picker.saved.cursor, picker: null });
  if (key.kind === "text" || key.kind === "paste") {
    return { ...state, picker: withQuery(picker, picker.query + clean(key.text.split("\n")[0])) };
  }
  switch (key.name) {
    case "escape":
      return restore();
    case "c":
      return key.ctrl ? restore() : state;
    case "enter":
      return choose(state, picker, ctx);
    case "up":
      return { ...state, picker: moveSelection(picker, -1) };
    case "down":
      return { ...state, picker: moveSelection(picker, 1) };
    case "tab":
      return { ...state, picker: moveSelection(picker, key.shift ? -1 : 1) };
    case "p":
    case "n":
      return key.ctrl ? { ...state, picker: moveSelection(picker, key.name === "p" ? -1 : 1) } : state;
    case "backspace":
      return { ...state, picker: withQuery(picker, picker.query.slice(0, prevBoundary(picker.query, picker.query.length))) };
    case "u":
      return key.ctrl ? { ...state, picker: withQuery(picker, "") } : state;
    default:
      return state;
  }
}

// ---- the reducer -------------------------------------------------------------------------

export function reduce(state: EditorState, key: Key, ctx: PromptContext, opts: ReduceOptions): EditorState {
  if (state.picker) return pickerKey(state, state.picker, key, ctx);

  if (key.kind === "text") return insert(state, clean(key.text), ctx);
  if (key.kind === "paste") {
    const lines = key.text.split("\n");
    let next = state;
    for (const [i, text] of lines.entries()) {
      next = insert(next, clean(text), ctx);
      if (i < lines.length - 1) next = submit(next, next.line);
    }
    return next;
  }

  const { line, cursor, menu } = state;
  const word = key.alt || key.ctrl;
  switch (key.name) {
    case "enter":
      return pressEnter(state, ctx, opts);
    case "tab":
      if (menu) {
        const count = menu.items.length;
        return { ...state, menu: { ...menu, selected: (menu.selected + (key.shift ? -1 : 1) + count) % count } };
      }
      return key.shift ? state : pressTab(state, ctx, opts);
    case "escape":
      return menu ? { ...state, menu: null } : state;
    case "up":
    case "down": {
      const by = key.name === "up" ? -1 : 1;
      if (menu) return { ...state, menu: { ...menu, selected: (menu.selected + by + menu.items.length) % menu.items.length } };
      return history(state, ctx, by);
    }
    case "left":
      return move(state, word ? wordLeft(line, cursor) : prevBoundary(line, cursor));
    case "right":
      if (cursor === line.length) return acceptGhost(state, ctx, word) ?? state;
      return move(state, word ? wordRight(line, cursor) : nextBoundary(line, cursor));
    case "home":
      return move(state, 0);
    case "end":
      return cursor === line.length ? acceptGhost(state, ctx, false) ?? state : move(state, line.length);
    case "backspace":
      return word ? cut(state, wordLeft(line, cursor), cursor, ctx) : cut(state, prevBoundary(line, cursor), cursor, ctx);
    case "delete":
      return word ? cut(state, cursor, wordRight(line, cursor), ctx) : cut(state, cursor, nextBoundary(line, cursor), ctx);
    case "pagedown":
    case "pageup":
      return line === "" && ctx.working ? submit(state, key.name === "pagedown" ? "next" : "prev") : state;
    default:
      break;
  }

  if (key.alt) {
    switch (key.name) {
      case "b":
        return move(state, wordLeft(line, cursor));
      case "f":
        if (cursor === line.length) return acceptGhost(state, ctx, true) ?? state;
        return move(state, wordRight(line, cursor));
      case "d":
        return cut(state, cursor, wordRight(line, cursor), ctx);
      default:
        return state;
    }
  }
  if (!key.ctrl) return state;
  switch (key.name) {
    case "a":
      return move(state, 0);
    case "e":
      return cursor === line.length ? acceptGhost(state, ctx, false) ?? state : move(state, line.length);
    case "b":
      return move(state, prevBoundary(line, cursor));
    case "f":
      return cursor === line.length ? acceptGhost(state, ctx, false) ?? state : move(state, nextBoundary(line, cursor));
    case "w":
      return cut(state, wordLeft(line, cursor), cursor, ctx);
    case "u":
      return cut(state, 0, cursor, ctx);
    case "k":
      return cut(state, cursor, line.length, ctx);
    case "p":
      return menu ? reduce(state, { ...key, name: "up", ctrl: false }, ctx, opts) : history(state, ctx, -1);
    case "n":
      return menu ? reduce(state, { ...key, name: "down", ctrl: false }, ctx, opts) : history(state, ctx, 1);
    case "c":
      return emit({ ...state, line: "", cursor: 0, nav: null, menu: null }, { kind: "interrupt", line });
    case "d":
      return line === "" ? emit(state, { kind: "eof" }) : cut(state, cursor, nextBoundary(line, cursor), ctx);
    case "l":
      return emit(state, { kind: "clear-screen" });
    case "r":
      return opts.interactive ? { ...state, picker: historyPicker(line, cursor, ctx.history), menu: null } : state;
    default:
      return state;
  }
}

/** The events to act on, and the state without them. */
export function drain(state: EditorState): [readonly EditorEvent[], EditorState] {
  return state.events.length === 0 ? [[], state] : [state.events, { ...state, events: [] }];
}

/** What the prompt line shows before `›`: the folder inside the project, the open photo, the read-only pill. */
function promptParts(ctx: PromptContext): Pick<PromptView, "folder" | "open" | "readOnly"> {
  const p = ctx.platform === "win32" ? path.win32 : path.posix;
  const folder = ctx.root ? p.relative(ctx.root, ctx.cwd) : "";
  const working = ctx.working;
  const rel = working?.rels[working.at];
  const file = rel?.slice(rel.lastIndexOf("/") + 1);
  const dot = file?.lastIndexOf(".") ?? -1;
  return {
    ...(folder !== "" && !folder.startsWith("..") && { folder: ctx.platform === "win32" ? folder.replace(/\\/g, "/") : folder }),
    ...(working && file !== undefined && { open: { name: dot > 0 ? file.slice(0, dot) : file, at: working.at + 1, of: working.rels.length } }),
    ...(ctx.readOnly === true && { readOnly: true }),
  };
}

export function viewOf(state: EditorState, ctx: PromptContext): PromptView {
  const analysis = analyze(state.line, state.cursor, ctx);
  const quiet = state.menu !== null || state.picker !== null;
  return {
    ...promptParts(ctx),
    projectName: ctx.projectName,
    line: state.line,
    cursor: state.cursor,
    tokens: highlight(state.line, state.cursor, ctx, analysis),
    ghost: quiet ? null : ghostFor(state.line, state.cursor, ctx, analysis),
    footer: footerFor(state.line, state.cursor, ctx, analysis),
    menu: state.menu ? menuView(state.menu) : null,
    picker: state.picker ? pickerView(state.picker) : null,
  };
}

/** The view a finished line leaves in scrollback: no ghost, no menu, cursor at its end. */
export function finalView(line: string, ctx: PromptContext): PromptView {
  return {
    ...promptParts(ctx),
    projectName: ctx.projectName,
    line,
    cursor: line.length,
    tokens: highlight(line, line.length, ctx),
    ghost: null,
    footer: { kind: "hints" },
    menu: null,
    picker: null,
  };
}

/** Menu contents follow new data (a folder read, photos loaded). */
export function refreshMenu(state: EditorState, ctx: PromptContext): EditorState {
  return state.menu ? { ...state, menu: menuAt(state.line, state.cursor, ctx) } : state;
}
