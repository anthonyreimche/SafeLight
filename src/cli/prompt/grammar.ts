// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What each word of a typed line is: the verb, an option, a key=value, or the
// photo, key or choice a verb's usage line asks for. Highlighting, the footer,
// completion and the pickers all read the line through this.

import { findCommand, GLOBAL_OPTIONS } from "../args";
import { hasGlob } from "../glob";
import { tokenize, type Token } from "../line-split";
import { type AssignOp, type CommandSpec, type OptionSpec, type ValueInfo, COMMAND } from "../types";
import { isPhotoName, type BuiltinSpec, type PromptContext } from "./context";

export type SlotKind = "photo" | "key" | "choice" | "number" | "verb" | "folder" | "extension" | "text";

export interface Slot {
  kind: SlotKind;
  required: boolean;
  many: boolean;
  choices?: readonly string[];
  range?: { min: number; max: number };
}

export interface Grammar { slots: Slot[]; assigns: "required" | "optional" | "none" }

export type WordRole =
  | { kind: "command" }
  | { kind: "verb" }
  | { kind: "option"; spec: OptionSpec | null }
  | { kind: "option-value" }
  | { kind: "assign"; key: string; op: AssignOp; keyEnd: number; opEnd: number; info: ValueInfo | undefined }
  | { kind: "slot"; slot: Slot }
  | { kind: "extra" };

export interface Word extends Token { role: WordRole }

export interface Analysis {
  words: Word[];
  verb: Word | null;
  spec: CommandSpec | null;
  builtin: BuiltinSpec | null;
  grammar: Grammar | null;
  /** The word holding the cursor (touching either end counts), or null between words. */
  at: Word | null;
}

export const BUILTIN_SPECS: readonly BuiltinSpec[] = [
  { verb: "cd", usage: "cd [folder]", summary: "Changes the folder commands run in." },
  { verb: "next", usage: "next [n]", summary: "Shows the next open photo; n skips ahead." },
  { verb: "prev", usage: "prev [n]", summary: "Shows the open photo before this one." },
  { verb: "close", usage: "close", summary: "Closes the open photos." },
  { verb: "home", usage: "home", summary: "Shows the home screen again." },
  { verb: "clear", aliases: ["cls"], usage: "clear", summary: "Clears the screen." },
  { verb: "exit", aliases: ["quit"], usage: "exit", summary: "Leaves the prompt." },
];

const EXTENSION_VERBS = new Set(["uninstall", "enable", "disable", "update"]);
const ASSIGNMENT = /^([A-Za-z][\w.-]*?)(\+=|-=|=)/;

/** `@` names the current open photo, `@all` every open one. */
export const SET_WORDS: readonly string[] = ["@", "@all"];
/** Verbs whose photos are what is on disk or what to open, so the open set never stands in for them. */
export const IGNORES_SET = new Set(["photos", "ls", "open", "import"]);
/** Verbs that take photos the catalogue doesn't have yet. */
export const TAKES_NEW = new Set(["open", "import", "ls"]);

export function findBuiltin(builtins: readonly BuiltinSpec[], word: string): BuiltinSpec | null {
  return builtins.find((b) => b.verb === word || b.aliases?.includes(word)) ?? null;
}

const grammarCache = new Map<string, Grammar>();

/** A verb whose words are its own (CommandSpec.rawArgs): any words, then photos after `--`. */
const RAW_GRAMMAR: Grammar = {
  slots: [{ kind: "text", required: false, many: true }, { kind: "photo", required: false, many: true }],
  assigns: "none",
};

/** The slots a usage line names: `set <photos> key=value…`, `flag <photos> pick|reject|none`. */
export function grammarOf(usage: string): Grammar {
  const cached = grammarCache.get(usage);
  if (cached) return cached;
  const verb = usage.split(/\s+/)[0];
  const parts = usage.match(/\[[^\]]*\]…?|<[^>]*>…?|\S+/g) ?? [];
  const grammar: Grammar = { slots: [], assigns: "none" };
  for (const part of parts.slice(1)) {
    const required = !part.startsWith("[");
    const many = part.includes("…");
    const inner = part.replace(/…/g, "").replace(/^[[<]|[\]>]$/g, "");
    if (inner.startsWith("-") || inner === "options" || inner === "filters") continue;
    if (inner.startsWith("key=")) {
      grammar.assigns = required ? "required" : "optional";
      continue;
    }
    const range = /^(\d+)-(\d+)$/.exec(inner);
    let slot: Slot;
    if (inner.includes("|")) slot = { kind: "choice", required, many, choices: inner.split("|") };
    else if (range) slot = { kind: "number", required, many, range: { min: Number(range[1]), max: Number(range[2]) } };
    else if (inner === "n") slot = { kind: "number", required, many };
    else if (inner === "photo" || inner === "photos") slot = { kind: "photo", required, many: many || inner === "photos" };
    else if (inner === "key") slot = { kind: "key", required, many };
    else if (inner === "verb") slot = { kind: "verb", required, many };
    else if (inner === "folder") slot = { kind: "folder", required, many };
    else if (inner === "name" && EXTENSION_VERBS.has(verb)) slot = { kind: "extension", required, many };
    else slot = { kind: "text", required, many };
    grammar.slots.push(slot);
  }
  grammarCache.set(usage, grammar);
  return grammar;
}

/** Whether `text` could be the thing `slot` asks for, judged from what is known. */
function fits(text: string, slot: Slot, ctx: PromptContext): boolean {
  switch (slot.kind) {
    case "photo":
      return hasGlob(text) || /[\\/]/.test(text) || isPhotoName(text) || SET_WORDS.includes(text) || ctx.index?.find(text) !== undefined;
    case "key":
      return ctx.valueOf(text) !== undefined;
    case "choice":
      return slot.choices?.includes(text.toLowerCase()) ?? false;
    case "number":
      return /^[+-]?\d+$/.test(text);
    default:
      return false;
  }
}

function optionsOf(spec: CommandSpec | null): OptionSpec[] {
  return [...GLOBAL_OPTIONS, ...(spec?.options ?? [])];
}

export function findOption(spec: CommandSpec | null, word: string): OptionSpec | null {
  if (word.startsWith("--")) {
    const name = word.slice(2).split("=")[0];
    return optionsOf(spec).find((o) => o.name === name) ?? null;
  }
  const alias = word.slice(1);
  return optionsOf(spec).find((o) => o.alias === alias) ?? null;
}

export function analyze(line: string, cursor: number, ctx: PromptContext): Analysis {
  const tokens = tokenize(line, ctx.platform);
  const words: Word[] = [];
  let verb: Word | null = null;
  let spec: CommandSpec | null = null;
  let builtin: BuiltinSpec | null = null;
  let grammar: Grammar | null = null;
  let slotAt = 0;
  const used: number[] = [];
  let valueNext = false;
  let afterDashDash = false;

  for (const [i, token] of tokens.entries()) {
    const raw = line.slice(token.start, token.end);
    const push = (role: WordRole): void => { words.push({ ...token, role }); };

    if (i === 0 && token.text === COMMAND && tokens.length > 1) {
      push({ kind: "command" });
      continue;
    }
    if (verb === null) {
      if (token.text.startsWith("-")) {
        push({ kind: "option", spec: findOption(null, token.text) });
        continue;
      }
      push({ kind: "verb" });
      verb = words[words.length - 1];
      spec = findCommand(ctx.commands, token.text);
      builtin = spec ? null : findBuiltin(ctx.builtins, token.text);
      const usage = spec?.usage ?? builtin?.usage;
      grammar = spec?.rawArgs ? RAW_GRAMMAR : usage ? grammarOf(usage) : null;
      continue;
    }
    if (spec?.rawArgs && !afterDashDash) {
      if (token.quote === null && token.text === "--") {
        afterDashDash = true;
        push({ kind: "option", spec: null });
      } else push({ kind: "slot", slot: RAW_GRAMMAR.slots[0] });
      continue;
    }
    if (valueNext) {
      valueNext = false;
      push({ kind: "option-value" });
      continue;
    }
    if (!afterDashDash && token.quote === null && token.text.startsWith("-") && token.text !== "-") {
      if (token.text === "--") afterDashDash = true;
      const option = token.text === "--" ? null : findOption(spec, token.text);
      push({ kind: "option", spec: option });
      if (option && option.kind !== "flag" && !token.text.includes("=")) valueNext = true;
      continue;
    }
    const assignment = afterDashDash ? null : ASSIGNMENT.exec(raw);
    if (assignment) {
      const keyEnd = token.start + assignment[1].length;
      push({
        kind: "assign", key: assignment[1], op: assignment[2] as AssignOp,
        keyEnd, opEnd: keyEnd + assignment[2].length, info: ctx.valueOf(assignment[1]),
      });
      continue;
    }
    const slots = grammar?.slots ?? [];
    if (afterDashDash) {
      const photo = slots.find((s) => s.kind === "photo");
      push(photo ? { kind: "slot", slot: photo } : { kind: "extra" });
      continue;
    }
    while (slotAt < slots.length) {
      const slot = slots[slotAt];
      const next = slots[slotAt + 1];
      const count = used[slotAt] ?? 0;
      if (count > 0 && !slot.many) { slotAt++; continue; }
      const fitsHere = fits(token.text, slot, ctx);
      const fitsNext = next !== undefined && fits(token.text, next, ctx);
      // After the first of many photos, a word that can't be a photo is the required word that follows.
      if (next && (fitsNext ? count > 0 || !fitsHere : count > 0 && !fitsHere && next.required)) {
        slotAt++;
        continue;
      }
      break;
    }
    const slot = slots[slotAt];
    if (slot) {
      used[slotAt] = (used[slotAt] ?? 0) + 1;
      push({ kind: "slot", slot });
    } else push({ kind: "extra" });
  }

  const at = words.find((w) => w.start <= cursor && cursor <= w.end) ?? null;
  return { words, verb, spec, builtin, grammar, at };
}

/** Whether the line asks for every photo some other way than naming them. */
export function choosesPhotosOtherwise(analysis: Analysis): boolean {
  return analysis.words.some((w) => w.role.kind === "option" && (w.text === "--all" || w.text === "--" || w.text === "-"))
    || analysis.words.some((w) => w.text === "-" && w.role.kind !== "verb");
}

export const isPhotoWord = (w: Word): boolean => w.role.kind === "slot" && w.role.slot.kind === "photo";

/** Whether a set is open and the line's verb would take its current photo when it names none. */
export function takesCurrent(analysis: Analysis, ctx: PromptContext): boolean {
  const { spec, grammar } = analysis;
  return ctx.current !== null && spec !== null && !IGNORES_SET.has(spec.verb)
    && (grammar?.slots.some((s) => s.kind === "photo") ?? false) && !choosesPhotosOtherwise(analysis);
}

/** Whether the line runs on the current open photo: it names no photo, and its verb takes one. */
export const actsOnCurrent = (analysis: Analysis, ctx: PromptContext): boolean =>
  takesCurrent(analysis, ctx) && !analysis.words.some(isPhotoWord);
