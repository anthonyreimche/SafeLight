// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Pickers: a fuzzy list that opens after enter on a line missing a photo, a
// key or a choice, and for ctrl+r through history. Esc puts the line back
// exactly as it was.

import type { Candidate } from "../complete";
import type { PromptContext } from "./context";
import { analyze, choosesPhotosOtherwise, takesCurrent, type Analysis } from "./grammar";
import { currentValue, typedValue } from "./highlight";
import type { PickerView } from "./view";

export const PICKER_ROWS = 8;

export interface PickerState {
  purpose: "photo" | "key" | "choice" | "history";
  title: string;
  empty: string;
  query: string;
  all: readonly Candidate[];
  shown: readonly Candidate[];
  selected: number;
  /** The line as it was, for esc. */
  saved: { line: string; cursor: number };
  /** The choice replaces [at, end); `pad` puts a space before it when the line needs one. */
  place: { at: number; end: number; pad: boolean };
  /** The line runs once the choice is in it (and nothing else is missing). */
  run: boolean;
}

// ---- fuzzy matching ----------------------------------------------------------

const isBoundary = (text: string, i: number): boolean => i === 0 || /[\s/\\_.\-]/.test(text[i - 1]) || (/[a-z]/.test(text[i - 1]) && /[A-Z]/.test(text[i]));

/** A subsequence match of `query` in `text`, scored: word starts and runs count most; null when it doesn't match. */
export function fuzzyScore(query: string, text: string): { score: number; positions: number[] } | null {
  if (query === "") return { score: 0, positions: [] };
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const positions: number[] = [];
  let score = 0;
  let from = 0;
  for (const ch of q) {
    // Prefer the next word start holding this letter, else the next letter.
    let at = -1;
    for (let i = from; i < t.length; i++) {
      if (t[i] !== ch) continue;
      if (at < 0) at = i;
      if (isBoundary(text, i)) { at = i; break; }
      if (positions.length > 0 && i === positions[positions.length - 1] + 1) break;
    }
    if (at < 0) return null;
    const previous = positions[positions.length - 1];
    score += 1;
    if (isBoundary(text, at)) score += 8;
    if (previous !== undefined && at === previous + 1) score += 5;
    if (previous !== undefined) score -= Math.min(3, at - previous - 1) * 0.5;
    else score -= Math.min(at, 10) * 0.2;
    positions.push(at);
    from = at + 1;
  }
  return { score: score - text.length * 0.01, positions };
}

export function filterCandidates(items: readonly Candidate[], query: string): Candidate[] {
  if (query === "") return [...items];
  const scored: { item: Candidate; score: number; order: number }[] = [];
  items.forEach((item, order) => {
    const hit = fuzzyScore(query, item.label);
    if (hit) scored.push({ item, score: hit.score, order });
  });
  return scored.sort((a, b) => b.score - a.score || a.order - b.order).map((s) => s.item);
}

// ---- state ---------------------------------------------------------------------

function open(base: Omit<PickerState, "query" | "shown" | "selected">): PickerState {
  return { ...base, query: "", shown: [...base.all], selected: 0 };
}

export function withQuery(state: PickerState, query: string): PickerState {
  return { ...state, query, shown: filterCandidates(state.all, query), selected: 0 };
}

export function moveSelection(state: PickerState, by: number): PickerState {
  const count = state.shown.length;
  return count === 0 ? state : { ...state, selected: (state.selected + by + count) % count };
}

export function pickerView(state: PickerState): PickerView {
  return {
    title: state.title,
    query: state.query,
    items: state.shown.map(({ label, detail, group }) => ({ label, ...(detail !== undefined && { detail }), ...(group !== undefined && { group }) })),
    selected: state.selected,
    rows: PICKER_ROWS,
    empty: state.empty,
  };
}

/** The line with `item` placed where the picker said. */
export function placeChoice(state: PickerState, item: Candidate): { line: string; cursor: number } {
  const { line } = state.saved;
  const { at, end, pad } = state.place;
  const before = line.slice(0, at);
  const after = line.slice(end);
  const space = pad && before !== "" && !/\s$/.test(before) ? " " : "";
  const inserted = space + item.text;
  return { line: before + inserted + after, cursor: before.length + inserted.length };
}

// ---- what a line is missing ------------------------------------------------------

const STARS = (n: number): string => "★".repeat(n) + "·".repeat(Math.max(0, 5 - n));

function quotedPath(rel: string): string {
  return /[\s"']/.test(rel) ? `"${rel}"` : rel;
}

/** The catalogue's photos under the prompt's folder, and with `fresh` the ones on disk here not imported yet. */
function photoCandidates(ctx: PromptContext, fresh: boolean): Candidate[] {
  const index = ctx.index;
  if (!index) return [];
  const known: Candidate[] = index.all
    .filter((p) => !p.rel.startsWith("../"))
    .map((p) => ({ text: quotedPath(p.rel), label: p.rel, detail: `${STARS(p.rating)}${p.flag === "none" ? "" : `  ${p.flag}`}` }));
  const added: Candidate[] = fresh
    ? index.children("").filter((e) => e.fresh === true).map((e) => ({ text: quotedPath(e.name), label: e.name, detail: "not imported" }))
    : [];
  return [...known, ...added].sort((a, b) => a.label.localeCompare(b.label));
}

/** The picker a line needs before it can run, or null when it can run as typed. */
export function missingPicker(line: string, ctx: PromptContext, analysis: Analysis = analyze(line, line.length, ctx)): PickerState | null {
  const { grammar, verb, spec } = analysis;
  if (!grammar || !verb || !spec) return null;
  const saved = { line, cursor: line.length };
  const words = analysis.words;
  const filled = (kind: string) => words.some((w) => w.role.kind === "slot" && w.role.slot.kind === kind);
  const end = { at: line.length, end: line.length, pad: true };
  const choosePhoto = (all: Candidate[]): PickerState =>
    open({ purpose: "photo", title: "Choose a photo", empty: "No photos match", all, saved, place: { at: verb.end, end: verb.end, pad: true }, run: true });

  // `open` with nothing lists the set when one is open; with none, it picks from the folder.
  if (spec.verb === "open") {
    if (ctx.working || words.length > 1) return null;
    const all = photoCandidates(ctx, true);
    return all.length > 0 ? choosePhoto(all) : null;
  }

  const photoSlot = grammar.slots.find((s) => s.kind === "photo" && s.required);
  if (photoSlot && !filled("photo") && !choosesPhotosOtherwise(analysis) && !takesCurrent(analysis, ctx)) {
    const all = photoCandidates(ctx, false);
    if (all.length > 0) return choosePhoto(all);
  }

  for (const slot of grammar.slots) {
    if (!slot.required || words.some((w) => w.role.kind === "slot" && w.role.slot === slot)) continue;
    if (slot.kind === "choice") {
      const all = (slot.choices ?? []).map((c): Candidate => ({ text: c, label: c }));
      return open({ purpose: "choice", title: `Choose a ${spec.verb}`, empty: "Nothing matches", all, saved, place: end, run: true });
    }
    if (slot.kind === "number" && slot.range) {
      const { min, max } = slot.range;
      const all = Array.from({ length: max - min + 1 }, (_, i): Candidate => ({ text: String(min + i), label: String(min + i), detail: STARS(min + i) }));
      return open({ purpose: "choice", title: "Choose a rating", empty: "Nothing matches", all, saved, place: end, run: true });
    }
  }

  if (grammar.assigns === "required" && !words.some((w) => w.role.kind === "assign")) {
    const all = ctx.values.filter((v) => v.settable).map((v): Candidate => {
      const now = currentValue(analysis, ctx, v);
      const value = now === undefined ? undefined : typedValue(v, now) + (v.unit && v.kind === "number" ? ` ${v.unit}` : "");
      return { text: `${v.key}=`, label: v.key, group: v.tool.name, ...(value !== undefined && { detail: value }) };
    });
    return open({ purpose: "key", title: "Choose a value", empty: "No values match", all, saved, place: end, run: false });
  }

  const empty = words.find((w) => w.role.kind === "assign" && w.role.opEnd === w.end && w.role.info
    && (w.role.info.kind === "choice" || w.role.info.kind === "switch"));
  if (empty && empty.role.kind === "assign" && empty.role.info) {
    const info = empty.role.info;
    const all = info.kind === "switch"
      ? [{ text: "on", label: "on" }, { text: "off", label: "off" }]
      : (info.choices ?? []).map((c): Candidate => ({ text: c.value, label: c.value, ...(c.label.toLowerCase() !== c.value.toLowerCase() && { detail: c.label }) }));
    return open({ purpose: "choice", title: `Choose ${info.label}`, empty: "Nothing matches", all, saved, place: { at: empty.end, end: empty.end, pad: false }, run: true });
  }
  return null;
}

export function historyPicker(line: string, cursor: number, history: readonly string[]): PickerState {
  const seen = new Set<string>();
  const all: Candidate[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    if (seen.has(history[i])) continue;
    seen.add(history[i]);
    all.push({ text: history[i], label: history[i] });
  }
  const state = open({
    purpose: "history", title: "History", empty: "Nothing in history matches", all,
    saved: { line, cursor }, place: { at: 0, end: line.length, pad: false }, run: false,
  });
  return line.trim() === "" ? state : withQuery(state, line);
}
