// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What fits where the cursor is: verbs, a verb's options, photos and folders,
// value keys, a key's choices, installed extension names. It reads only the
// prompt's snapshot, so it answers at once; a folder not read yet answers
// nothing until the snapshot has it.

import { homedir } from "node:os";
import path from "node:path";
import { GLOBAL_OPTIONS } from "./args";
import { tokenize } from "./line-split";
import { isPhotoName, normKey, type PromptContext } from "./prompt/context";
import { analyze, type Analysis, type Slot, type Word } from "./prompt/grammar";
import { currentValue, typedValue } from "./prompt/highlight";

export interface Candidate {
  /** What replaces the word. */
  text: string;
  label: string;
  detail?: string;
  group?: string;
}

/** The candidates for the word from `start` to `end`; `typed` is its text up to the cursor. */
export interface Completion { start: number; end: number; typed: string; items: Candidate[] }

const STARS = (n: number): string => "★".repeat(n) + "·".repeat(Math.max(0, 5 - n));

function quoted(value: string, quote: string | null, closed: boolean): string {
  const q = quote ?? (/[\s"']/.test(value) ? "\"" : null);
  return q === null ? value : `${q}${value}${closed ? q : ""}`;
}

function startsWith(name: string, prefix: string, fold: boolean): boolean {
  return fold ? name.toLowerCase().startsWith(prefix.toLowerCase()) : name.startsWith(prefix);
}

function paths(typed: string, quote: string | null, ctx: PromptContext, foldersOnly: boolean): Candidate[] {
  const p = ctx.platform === "win32" ? path.win32 : path.posix;
  const cut = (ctx.platform === "win32" ? /[\\/][^\\/]*$/ : /\/[^/]*$/).exec(typed);
  const dirPart = cut ? typed.slice(0, cut.index + 1) : "";
  const base = cut ? typed.slice(cut.index + 1) : typed;
  const sep = dirPart.includes("/") || ctx.platform !== "win32" ? "/" : "\\";
  const showHidden = base.startsWith(".");

  let entries: { name: string; dir: boolean; detail?: string }[];
  if (ctx.index && !foldersOnly && !dirPart.startsWith("~")) {
    entries = ctx.index.children(ctx.index.relOf(dirPart)).map((e) => ({
      name: e.name, dir: e.dir, ...(e.photo && { detail: `${STARS(e.photo.rating)}${e.photo.flag === "none" ? "" : `  ${e.photo.flag}`}` }),
    }));
  } else {
    const expanded = dirPart.startsWith("~") ? homedir() + dirPart.slice(1) : dirPart;
    const all = ctx.dir(expanded === "" ? ctx.cwd : p.resolve(ctx.cwd, expanded)) ?? [];
    const usable = all.filter((e) => (!foldersOnly || e.dir) && startsWith(e.name, base, ctx.fold));
    const favoured = usable.filter((e) => e.dir || isPhotoName(e.name));
    entries = favoured.length > 0 || foldersOnly ? favoured : usable;
  }
  return entries
    .filter((e) => startsWith(e.name, base, ctx.fold) && (showHidden || !e.name.startsWith(".")))
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
    .map((e) => {
      const full = `${dirPart}${base}${e.name.slice(base.length)}${e.dir ? sep : ""}`;
      return { text: quoted(full, quote, !e.dir), label: `${dirPart}${e.name}${e.dir ? sep : ""}`, detail: e.detail ?? (e.dir ? "folder" : undefined) };
    });
}

function keys(typed: string, analysis: Analysis, ctx: PromptContext, assign: boolean): Candidate[] {
  return ctx.values
    .filter((v) => (!assign || v.settable) && startsWith(normKey(v.key), normKey(typed), true))
    .map((v) => {
      const now = currentValue(analysis, ctx, v);
      const value = now === undefined ? null : typedValue(v, now) + (v.unit && v.kind === "number" ? ` ${v.unit}` : "");
      return { text: assign ? `${v.key}=` : v.key, label: v.key, detail: [value, v.tool.name].filter(Boolean).join("   "), group: v.tool.name };
    });
}

const fromWords = (words: readonly string[], typed: string, fold: boolean, detail?: (w: string) => string | undefined): Candidate[] =>
  [...new Set(words)].filter((w) => startsWith(w, typed, fold)).map((w) => ({ text: w, label: w, ...(detail && { detail: detail(w) }) }));

/** The slots a word at the cursor could fill, most likely first. */
function slotsAt(analysis: Analysis, word: Word | null): Slot[] {
  const slots = analysis.grammar?.slots ?? [];
  if (word?.role.kind === "slot") {
    const { slot } = word.role;
    const next = slots[slots.indexOf(slot) + 1];
    const others = analysis.words.filter((w) => w !== word && w.role.kind === "slot" && w.role.slot === slot);
    return next && slot.many && others.length > 0 ? [next, slot] : [slot];
  }
  const used = analysis.words.flatMap((w) => (w.role.kind === "slot" && w !== word ? [slots.indexOf(w.role.slot)] : []));
  const last = used.length > 0 ? Math.max(...used) : -1;
  if (last < 0) return slots.slice(0, 1);
  const lastSlot = slots[last];
  const next = slots[last + 1];
  if (lastSlot.many) return next ? [next, lastSlot] : [lastSlot];
  return next ? [next] : [];
}

export function complete(line: string, cursor: number, ctx: PromptContext): Completion {
  const analysis = analyze(line, cursor, ctx);
  const word = analysis.at;
  const start = word ? word.start : cursor;
  const end = word ? word.end : cursor;
  const typed = word ? (tokenize(line.slice(word.start, cursor), ctx.platform)[0]?.text ?? "") : "";
  const reply = (items: Candidate[], from = start, to = end, text = typed): Completion => ({ start: from, end: to, typed: text, items });

  if (!word && analysis.verb === null) return reply([]);
  if (word?.role.kind === "verb" || word?.role.kind === "command") {
    if (typed.startsWith("-")) return reply([]);
    const verbs = [...ctx.commands.map((c) => ({ verb: c.verb, summary: c.summary })), ...ctx.builtins];
    return reply(verbs.filter((v) => startsWith(v.verb, typed, ctx.fold)).map((v) => ({ text: v.verb, label: v.verb, detail: v.summary })));
  }
  if (word?.role.kind === "option" || (word && typed.startsWith("-") && word.role.kind !== "assign")) {
    if (typed.includes("=")) return reply([]);
    const options = [...GLOBAL_OPTIONS, ...(analysis.spec?.options ?? [])];
    return reply(options
      .filter((o) => startsWith(`--${o.name}`, typed, false))
      .map((o) => ({ text: `--${o.name}`, label: `--${o.name}`, detail: o.summary })));
  }
  if (word?.role.kind === "option-value") return reply([]);
  if (word?.role.kind === "assign") {
    const role = word.role;
    if (cursor <= role.keyEnd) return reply(keys(line.slice(word.start, cursor), analysis, ctx, false), word.start, role.keyEnd);
    const info = role.info;
    const value = line.slice(role.opEnd, cursor);
    const words = info?.kind === "choice" ? (info.choices ?? []).map((c) => c.value) : info?.kind === "switch" ? ["on", "off"] : [];
    return reply(fromWords(words, value, true), role.opEnd, word.end, value);
  }

  const verb = analysis.verb?.text;
  if (verb === "cd") return reply(analysis.words.length <= 2 ? paths(typed, word?.quote ?? null, ctx, true) : []);
  const items: Candidate[] = [];
  if (analysis.grammar?.assigns !== "none" && analysis.grammar) items.push(...keys(typed, analysis, ctx, true));
  for (const slot of slotsAt(analysis, word)) {
    switch (slot.kind) {
      case "photo":
        items.push(...paths(typed, word?.quote ?? null, ctx, false));
        break;
      case "key":
        if (analysis.words.some((w) => w.role.kind === "slot" && w.role.slot.kind === "photo" && w !== word)) items.push(...keys(typed, analysis, ctx, false));
        break;
      case "choice":
        items.push(...fromWords(slot.choices ?? [], typed, true));
        break;
      case "number":
        if (slot.range) {
          const { min, max } = slot.range;
          const all = Array.from({ length: max - min + 1 }, (_, i) => String(min + i));
          items.push(...fromWords(all, typed, false, (n) => STARS(Number(n))));
        }
        break;
      case "verb":
        items.push(...fromWords(ctx.commands.map((c) => c.verb), typed, ctx.fold, (v) => ctx.commands.find((c) => c.verb === v)?.summary));
        break;
      case "extension":
        items.push(...fromWords(ctx.extensionNames, typed, ctx.fold));
        break;
      default:
        break;
    }
  }
  return reply(items);
}
