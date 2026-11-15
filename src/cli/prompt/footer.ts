// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The line under the prompt, always about the word under the cursor. A value's
// slider takes `now` and `next` as positions on the value's own scale; for a
// choice or a switch they are the choice's index (off 0, on 1).

import { GLOBAL_OPTIONS } from "../args";
import { compileGlob, hasGlob, slashed } from "../glob";
import { closest } from "../suggest";
import type { CommandSpec, ValueInfo } from "../types";
import { actsOnCurrent, findBuiltin, findOption, isPhotoWord, type Analysis, type Word, analyze } from "./grammar";
import { currentValue, judgeValue, keyBeingTyped, namedPhoto, photoKind } from "./highlight";
import type { PhotoFact, PromptContext } from "./context";
import type { FooterView } from "./view";

/** The verbs whose footer counts what is on disk against the catalogue. */
const LISTS_DISK = new Set(["import", "ls"]);

function verbFooter(spec: CommandSpec | null, builtin: { usage: string; summary: string } | null): FooterView {
  const found = spec ?? builtin;
  return found ? { kind: "verb", usage: found.usage, summary: found.summary } : { kind: "hints" };
}

const nameOf = (rel: string): string => rel.slice(rel.lastIndexOf("/") + 1);

function photoFacts(photo: PhotoFact, ctx: PromptContext): Extract<FooterView, { kind: "photo" }> {
  const step = ctx.look(photo.rel)?.step;
  return { kind: "photo", name: nameOf(photo.rel), rating: photo.rating, flag: photo.flag, ...(step && { step }) };
}

/** Past the verb, with nothing more particular under the cursor: the open photo the line will act on,
 *  or for `import` and `ls` how the folder stands; otherwise the verb's usage. */
function lineFooter(analysis: Analysis, ctx: PromptContext): FooterView {
  const { spec, builtin } = analysis;
  if (ctx.current && ctx.working && actsOnCurrent(analysis, ctx)) {
    return { ...photoFacts(ctx.current, ctx), target: { open: ctx.working.rels.length } };
  }
  if (spec && LISTS_DISK.has(spec.verb)) {
    const folder = analysis.words.find((w) => isPhotoWord(w) && ctx.index?.isFolder(w.text));
    const listed = folderFooter(folder?.text ?? "", ctx);
    if (listed) return listed;
  }
  return verbFooter(spec, builtin);
}

function folderFooter(typed: string, ctx: PromptContext): FooterView | null {
  const index = ctx.index;
  if (!index) return null;
  const rel = index.relOf(typed);
  const counts = index.counts(rel);
  if (!counts) return null;
  return { kind: "matches", count: counts.photos, listing: { folder: rel === "" ? null : nameOf(rel), notImported: counts.notImported, gone: counts.gone } };
}

function position(info: ValueInfo, value: unknown): number | null {
  if (info.kind === "number") return typeof value === "number" ? value : null;
  if (info.kind === "switch") return typeof value === "boolean" ? Number(value) : null;
  if (info.kind === "choice") {
    const at = (info.choices ?? []).findIndex((c) => c.value === value);
    return at < 0 ? null : at;
  }
  return null;
}

function nowOf(info: ValueInfo, analysis: Analysis, ctx: PromptContext): number {
  const now = position(info, currentValue(analysis, ctx, info));
  if (now !== null) return now;
  if (info.kind !== "number") return 0;
  return info.default ?? Math.min(Math.max(0, info.min ?? 0), info.max ?? 0);
}

function unknownKey(key: string, ctx: PromptContext): FooterView {
  const guess = closest(key, ctx.values.map((v) => v.key));
  return guess
    ? { kind: "problem", message: `"${key}" isn't a value. Did you mean ${guess}?`, fix: guess }
    : { kind: "problem", message: `"${key}" isn't a value.` };
}

function photoFooter(word: Word, cursor: number, ctx: PromptContext, analysis: Analysis): FooterView {
  const index = ctx.index;
  const verb = analysis.spec?.verb;
  switch (photoKind(word, cursor, ctx, verb)) {
    case "photo": {
      if (word.text === "@all" && ctx.working) return { kind: "matches", count: ctx.working.rels.length };
      if (word.text === "@" && ctx.current) return photoFacts(ctx.current, ctx);
      const photo = index?.find(word.text);
      if (photo) return photoFacts(photo, ctx);
      if (index?.fresh(word.text)) return { kind: "photo", name: nameOf(index.relOf(word.text)), rating: 0, flag: "none", notImported: true };
      break;
    }
    case "glob": {
      if (!index) break;
      if (hasGlob(word.text)) {
        const pattern = compileGlob(slashed(index.relOf(word.text), ctx.platform), ctx.fold);
        return { kind: "matches", count: index.all.filter((p) => pattern.test(p.rel)).length };
      }
      if (verb !== undefined && LISTS_DISK.has(verb)) {
        const listed = folderFooter(word.text, ctx);
        if (listed) return listed;
      }
      return { kind: "matches", count: index.children(index.relOf(word.text)).filter((e) => !e.dir && e.photo).length };
    }
    case "photo-missing":
      if (word.text.startsWith("@")) return { kind: "problem", message: "No photo is open. open <photo> opens one." };
      if (index?.fresh(word.text)) return { kind: "problem", message: `${word.text} isn't imported.` };
      return { kind: "problem", message: `${word.text} isn't in this project.` };
    default:
      break;
  }
  return lineFooter(analysis, ctx);
}

function assignFooter(line: string, word: Word, cursor: number, analysis: Analysis, ctx: PromptContext): FooterView {
  if (word.role.kind !== "assign") return { kind: "hints" };
  const { info, key, keyEnd } = word.role;
  if (!info) return unknownKey(key, ctx);
  if (!info.settable && analysis.grammar?.assigns !== "none") {
    return { kind: "problem", message: info.notSettableReason ?? `${info.label} can't be set yet.` };
  }
  const now = nowOf(info, analysis, ctx);
  if (cursor <= keyEnd) return { kind: "slider", info, now };
  const judged = judgeValue(line, word, cursor, analysis, ctx);
  switch (judged.kind) {
    case "wrong":
      return { kind: "problem", message: judged.message };
    case "number":
      if (judged.limit !== null) return { kind: "stops", info, limit: judged.limit };
      return judged.target === null ? { kind: "slider", info, now } : { kind: "slider", info, now, next: judged.target };
    case "word":
      return { kind: "slider", info, now, next: judged.index };
    default:
      return { kind: "slider", info, now };
  }
}

export function footerFor(line: string, cursor: number, ctx: PromptContext, analysis: Analysis = analyze(line, cursor, ctx)): FooterView {
  if (line.trim() === "") return ctx.current ? { ...photoFacts(ctx.current, ctx), paging: true } : { kind: "hints" };
  const { verb, spec, builtin } = analysis;
  const word = analysis.at;

  if (verb && !spec && !builtin && verb.end < line.length && (word === verb || word === null || word.start > verb.end)) {
    const names = [...ctx.commands.flatMap((c) => [c.verb, ...(c.aliases ?? [])]), ...ctx.builtins.map((b) => b.verb)];
    const guess = closest(verb.text, names);
    return guess
      ? { kind: "problem", message: `"${verb.text}" isn't a command. Did you mean ${guess}?`, fix: guess }
      : { kind: "problem", message: `"${verb.text}" isn't a command.` };
  }
  if (!word) return lineFooter(analysis, ctx);

  switch (word.role.kind) {
    case "command":
      return { kind: "hints" };
    case "verb": {
      if (spec || builtin) return verbFooter(spec, builtin);
      const typed = word.text.toLowerCase();
      const command = ctx.commands.find((c) => c.verb.startsWith(typed)) ?? null;
      return verbFooter(command, command ? null : ctx.builtins.find((b) => b.verb.startsWith(typed)) ?? findBuiltin(ctx.builtins, typed));
    }
    case "option": {
      const option = word.role.spec ?? findOption(spec, word.text);
      if (option) return { kind: "verb", usage: `--${option.name}`, summary: option.summary };
      const options = [...GLOBAL_OPTIONS, ...(spec?.options ?? [])];
      if (cursor === word.end && options.some((o) => `--${o.name}`.startsWith(word.text))) return verbFooter(spec, builtin);
      return { kind: "problem", message: `${word.text} isn't an option of ${verb?.text ?? "safelight"}.` };
    }
    case "assign":
      return assignFooter(line, word, cursor, analysis, ctx);
    case "slot": {
      const { slot } = word.role;
      if (slot.kind === "photo") {
        const key = analysis.grammar?.assigns !== "none" ? keyBeingTyped(word, cursor, ctx) : undefined;
        return key ? { kind: "slider", info: key, now: nowOf(key, analysis, ctx) } : photoFooter(word, cursor, ctx, analysis);
      }
      if (slot.kind === "key") {
        const info = ctx.valueOf(word.text);
        if (info) return { kind: "slider", info, now: nowOf(info, analysis, ctx) };
        if (cursor !== word.end) return unknownKey(word.text, ctx);
      }
      return lineFooter(analysis, ctx);
    }
    default:
      return lineFooter(analysis, ctx);
  }
}

/** Whether the photo the footer would describe needs its values read. */
export function photoToRead(analysis: Analysis, ctx: PromptContext): string | null {
  return namedPhoto(analysis, ctx)?.rel ?? null;
}
