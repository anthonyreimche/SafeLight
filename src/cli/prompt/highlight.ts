// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Colours for the typed line: every run gets a TokenKind. Only what the session
// already holds is read; a word that can't be judged yet stays plain, and a
// word still being typed is never marked wrong while it could still be right.

import { hasGlob } from "../glob";
import type { ValueInfo } from "../types";
import { normKey, type PhotoFact, type PromptContext } from "./context";
import { analyze, findBuiltin, isPhotoWord, SET_WORDS, TAKES_NEW, takesCurrent, type Analysis, type Word } from "./grammar";
import type { Token, TokenKind } from "./view";

const NUMBER = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(\s*)(.*)$/i;
const SWITCH_WORDS = ["on", "off", "true", "false", "1", "0"];

/** What the value of a key=value says. Offsets are in the line. */
export type ValueJudgement =
  | { kind: "empty" }
  | { kind: "typing" }
  | { kind: "quoted" }
  | { kind: "default" }
  | { kind: "number"; numberEnd: number; unitStart: number; unitOk: boolean; target: number | null; limit: number | null }
  | { kind: "word"; index: number }
  | { kind: "wrong"; message: string };

const isTyping = (word: Word, cursor: number): boolean => cursor === word.end;
const startsWithFolded = (whole: string, part: string): boolean => whole.toLowerCase().startsWith(part.toLowerCase());

function unitMatches(own: string | undefined, unit: string): "yes" | "partial" | "no" {
  if (own === undefined) return "no";
  const typed = normKey(unit);
  if (typed === normKey(own) || (own === "°" && typed === "deg")) return "yes";
  return startsWithFolded(own, typed) || (own === "°" && "deg".startsWith(typed)) ? "partial" : "no";
}

/** A value as it would be typed: "+0.50", "5150", "on", "level". */
export function typedValue(info: ValueInfo, value: unknown): string {
  if (info.kind === "switch") return value === true ? "on" : "off";
  if (info.kind === "number" && typeof value === "number") {
    const text = value.toFixed(info.decimals ?? 2);
    return value > 0 && (info.min ?? 0) < 0 ? `+${text}` : text;
  }
  return String(value);
}

/** The one photo the line names, when exactly one is named and it is in the project; the current open
 *  photo when `@` names it, or when nothing does and the verb would take it. */
export function namedPhoto(analysis: Analysis, ctx: PromptContext): PhotoFact | null {
  const index = ctx.index;
  const named = analysis.words.filter((w) => isPhotoWord(w)
    && (SET_WORDS.includes(w.text) || (index !== null && (hasGlob(w.text) || index.isFolder(w.text) || index.find(w.text) !== undefined))));
  if (named.length === 0) return takesCurrent(analysis, ctx) ? ctx.current : null;
  if (named.length > 1) return null;
  if (named[0].text === "@") return ctx.current;
  return index?.find(named[0].text) ?? null;
}

export function currentValue(analysis: Analysis, ctx: PromptContext, info: ValueInfo): unknown {
  const photo = namedPhoto(analysis, ctx);
  return photo ? ctx.look(photo.rel)?.values.get(info.key) : undefined;
}

export function judgeValue(line: string, word: Word, cursor: number, analysis: Analysis, ctx: PromptContext): ValueJudgement {
  if (word.role.kind !== "assign" || !word.role.info) return { kind: "empty" };
  const { info, op, opEnd } = word.role;
  const raw = line.slice(opEnd, word.end);
  if (raw === "") return { kind: "empty" };
  if (word.quote !== null) return { kind: "quoted" };
  const typing = isTyping(word, cursor);
  if (raw.toLowerCase() === "default") return op === "=" ? { kind: "default" } : { kind: "wrong", message: `"default" works with "=", not "${op}".` };
  if (typing && "default".startsWith(raw.toLowerCase())) return { kind: "typing" };

  switch (info.kind) {
    case "number": {
      const m = NUMBER.exec(raw);
      if (!m) {
        if (typing && /^[+-]?\.?$/.test(raw)) return { kind: "typing" };
        return { kind: "wrong", message: `"${raw}" is not a number for ${info.label}.` };
      }
      const numberEnd = opEnd + m[1].length;
      const unitStart = numberEnd + m[2].length;
      const unit = m[3];
      if (unit !== "") {
        const match = unitMatches(info.unit, unit);
        if (match === "no" || (match === "partial" && !typing)) {
          return {
            kind: "wrong",
            message: info.unit ? `${info.label} is in ${info.unit}, not "${unit}".` : `${info.label} has no unit; "${raw}" can't take "${unit}".`,
          };
        }
      }
      const entered = Number(m[1]);
      const current = currentValue(analysis, ctx, info);
      const base = op === "=" ? 0 : typeof current === "number" ? current : null;
      let target = base === null ? null : op === "-=" ? base - entered : base + entered;
      if (target !== null && info.decimals === 0) target = Math.round(target) || 0;
      const limit = target === null ? null : Math.min(Math.max(target, info.min ?? -Infinity), info.max ?? Infinity);
      return { kind: "number", numberEnd, unitStart, unitOk: unitMatches(info.unit, unit) === "yes", target, limit: limit === target ? null : limit };
    }
    case "switch": {
      const index = SWITCH_WORDS.indexOf(raw.toLowerCase());
      if (index >= 0 && op === "=") return { kind: "word", index: index % 2 === 0 ? 1 : 0 };
      if (typing && SWITCH_WORDS.some((w) => w.startsWith(raw.toLowerCase()))) return { kind: "typing" };
      return { kind: "wrong", message: `${info.label} takes on or off, not "${raw}".` };
    }
    case "choice": {
      const choices = info.choices ?? [];
      const index = choices.findIndex((c) => c.value.toLowerCase() === raw.toLowerCase() || c.label.toLowerCase() === raw.toLowerCase());
      if (index >= 0 && op === "=") return { kind: "word", index };
      if (typing && choices.some((c) => startsWithFolded(c.value, raw) || startsWithFolded(c.label, raw))) return { kind: "typing" };
      return { kind: "wrong", message: `${info.label} takes one of: ${choices.map((c) => c.value).join(", ")}. Not "${raw}".` };
    }
    default:
      return { kind: "word", index: 0 };
  }
}

/** Whether a word in a photo slot of `verb` names something: a photo, a glob, a folder, or nothing yet. */
export function photoKind(word: Word, cursor: number, ctx: PromptContext, verb?: string): TokenKind {
  if (hasGlob(word.text)) return "glob";
  if (word.text.startsWith("@") && word.quote === null) {
    if (SET_WORDS.includes(word.text)) return ctx.current ? "photo" : "photo-missing";
    return ctx.current && isTyping(word, cursor) && "@all".startsWith(word.text) ? "plain" : "photo-missing";
  }
  const index = ctx.index;
  if (!index || word.text === "" || word.text === "-") return word.quote ? "quoted" : "plain";
  if (index.find(word.text)) return "photo";
  if (index.isFolder(word.text)) return "glob";
  if (verb !== undefined && TAKES_NEW.has(verb) && index.fresh(word.text)) return "photo";
  const rel = index.relOf(word.text);
  if (rel.startsWith("../") || /^[A-Za-z]:|^\//.test(rel)) return word.quote ? "quoted" : "plain";
  if (isTyping(word, cursor)) {
    const typed = ctx.fold ? rel.toLowerCase() : rel;
    const prefixed = index.all.some((p) => (ctx.fold ? p.rel.toLowerCase() : p.rel).startsWith(typed));
    if (prefixed) return "plain";
  }
  return "photo-missing";
}

/** In a line that takes key=value, the key a word still being typed is the start of. */
export function keyBeingTyped(word: Word, cursor: number, ctx: PromptContext): ValueInfo | undefined {
  if (!isTyping(word, cursor) || word.quote !== null || word.text === "") return undefined;
  const typed = normKey(word.text);
  return ctx.values.find((v) => v.settable && normKey(v.key).startsWith(typed));
}

function slotKind(word: Word, cursor: number, ctx: PromptContext, assigns: boolean, verb: string | undefined): TokenKind {
  if (word.role.kind !== "slot") return "plain";
  const { slot } = word.role;
  const typing = isTyping(word, cursor);
  const text = word.text;
  switch (slot.kind) {
    case "photo": {
      const kind = photoKind(word, cursor, ctx, verb);
      return kind === "photo-missing" && assigns && keyBeingTyped(word, cursor, ctx) ? "plain" : kind;
    }
    case "key":
      if (ctx.valueOf(text)) return "key";
      return typing && ctx.values.some((v) => startsWithFolded(normKey(v.key), normKey(text))) ? "plain" : "value-wrong";
    case "choice": {
      const choices = slot.choices ?? [];
      if (choices.includes(text.toLowerCase())) return "value";
      return typing && choices.some((c) => startsWithFolded(c, text)) ? "plain" : "value-wrong";
    }
    case "number": {
      if (!/^[+-]?\d+$/.test(text)) return typing && /^[+-]?$/.test(text) ? "plain" : "value-wrong";
      const n = Number(text);
      return slot.range && (n < slot.range.min || n > slot.range.max) ? "value-wrong" : "value";
    }
    case "verb":
      if (ctx.commands.some((c) => c.verb === text)) return "verb";
      return typing ? "plain" : "verb-unknown";
    case "folder": {
      if (text === "" || text === "~" || text === "-") return "plain";
      const entries = ctx.dir(ctx.cwd);
      if (/[\\/]/.test(text)) return "plain";
      if (!entries) return "plain";
      const folded = (s: string) => (ctx.fold ? s.toLowerCase() : s);
      if (entries.some((e) => e.dir && folded(e.name) === folded(text))) return "glob";
      return typing && entries.some((e) => e.dir && folded(e.name).startsWith(folded(text))) ? "plain" : "photo-missing";
    }
    default:
      return word.quote ? "quoted" : "plain";
  }
}

function verbKind(word: Word, line: string, ctx: PromptContext): TokenKind {
  const known = ctx.commands.some((c) => c.verb === word.text || c.aliases?.includes(word.text)) || findBuiltin(ctx.builtins, word.text);
  if (known) return "verb";
  return word.end < line.length ? "verb-unknown" : "plain";
}

/** The runs of one word. */
function wordRuns(line: string, word: Word, cursor: number, analysis: Analysis, ctx: PromptContext): Token[] {
  const whole = (kind: TokenKind): Token[] => [{ start: word.start, end: word.end, kind }];
  const role = word.role;
  switch (role.kind) {
    case "command":
      return whole("verb");
    case "verb":
      return whole(verbKind(word, line, ctx));
    case "option":
      return whole("option");
    case "option-value":
      return whole(word.quote ? "quoted" : "plain");
    case "extra":
      return whole(word.quote ? "quoted" : "plain");
    case "slot":
      return whole(slotKind(word, cursor, ctx, (analysis.grammar?.assigns ?? "none") !== "none", analysis.spec?.verb));
    case "assign": {
      const keyKind: TokenKind = role.info ? "key" : "value-wrong";
      const runs: Token[] = [
        { start: word.start, end: role.keyEnd, kind: keyKind },
        { start: role.keyEnd, end: role.opEnd, kind: "operator" },
      ];
      if (role.opEnd === word.end) return runs;
      const judged = judgeValue(line, word, cursor, analysis, ctx);
      const value = (kind: TokenKind): Token[] => [...runs, { start: role.opEnd, end: word.end, kind }];
      switch (judged.kind) {
        case "number": {
          const numberKind: TokenKind = judged.limit !== null ? "value-past" : "value";
          const out: Token[] = [...runs, { start: role.opEnd, end: judged.numberEnd, kind: numberKind }];
          if (judged.numberEnd < judged.unitStart) out.push({ start: judged.numberEnd, end: judged.unitStart, kind: "plain" });
          if (judged.unitStart < word.end) out.push({ start: judged.unitStart, end: word.end, kind: judged.unitOk ? "unit" : "plain" });
          return out;
        }
        case "wrong":
          return value("value-wrong");
        case "quoted":
          return value("quoted");
        case "typing":
        case "empty":
          return value("plain");
        default:
          return value(role.info ? "value" : "plain");
      }
    }
  }
}

export function highlight(line: string, cursor: number, ctx: PromptContext, analysis: Analysis = analyze(line, cursor, ctx)): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  let unknownVerb = false;
  for (const word of analysis.words) {
    if (word.start > at) tokens.push({ start: at, end: word.start, kind: "plain" });
    const runs = unknownVerb
      ? [{ start: word.start, end: word.end, kind: (word.quote ? "quoted" : "plain") as TokenKind }]
      : wordRuns(line, word, cursor, analysis, ctx);
    if (word.role.kind === "verb" && !analysis.spec && !analysis.builtin) unknownVerb = true;
    tokens.push(...runs);
    at = word.end;
  }
  if (at < line.length) tokens.push({ start: at, end: line.length, kind: "plain" });
  return tokens;
}
