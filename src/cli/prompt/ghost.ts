// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Faint text after the cursor, fish-style. First hit wins: the newest history
// line that starts with what is typed, then the line that fixes the last
// error, then the one thing the grammar allows (after `open `, the first
// photo of the folder `ls` last listed), then the photo's current value
// after `key=`.

import { COMMAND } from "../types";
import type { PromptContext } from "./context";
import { analyze, type Analysis } from "./grammar";
import { currentValue, typedValue } from "./highlight";
import { completeAt } from "./menu";

/** The line an error card's fix or hint gives to run, without the leading command name; null when
 *  it gives none (a hint that is a sentence, "safelight help lists them.", isn't one). */
export function fixLine(problem: { hint?: string; fix?: string }): string | null {
  const line = (problem.fix ?? problem.hint)?.trim();
  if (!line || line.endsWith(".") || !line.startsWith(`${COMMAND} `)) return null;
  return line.slice(COMMAND.length + 1).trim() || null;
}

function fromHistory(line: string, history: readonly string[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry.length > line.length && entry.startsWith(line)) return entry.slice(line.length);
  }
  return null;
}

function fromFix(line: string, fix: string | null | undefined): string | null {
  return fix && fix.length > line.length && fix.startsWith(line) ? fix.slice(line.length) : null;
}

function fromGrammar(line: string, cursor: number, ctx: PromptContext): string | null {
  const { items, start } = completeAt(line, cursor, ctx);
  if (items.length !== 1) return null;
  const typed = line.slice(start, cursor);
  const text = items[0].text;
  return typed !== "" && text.length > typed.length && text.startsWith(typed) ? text.slice(typed.length) : null;
}

/** After `open ` and nothing more: the first photo of the folder `ls` last listed. */
function fromListed(line: string, analysis: Analysis, ctx: PromptContext): string | null {
  if (analysis.spec?.verb !== "open" || analysis.words.length !== 1 || !/\s$/.test(line)) return null;
  const listed = ctx.listed;
  if (listed === null || listed === undefined || !ctx.index) return null;
  const first = ctx.index.children(listed).filter((e) => !e.dir).map((e) => e.name).sort((a, b) => a.localeCompare(b))[0];
  if (first === undefined) return null;
  const rel = listed === "" ? first : `${listed.replace(/\/+$/, "")}/${first}`;
  return /[\s"']/.test(rel) ? `"${rel}"` : rel;
}

function fromValue(line: string, analysis: Analysis, ctx: PromptContext): string | null {
  const word = analysis.at;
  if (word?.role.kind !== "assign" || !word.role.info || word.role.opEnd !== line.length) return null;
  const now = currentValue(analysis, ctx, word.role.info);
  return now === undefined ? null : typedValue(word.role.info, now);
}

export function ghostFor(line: string, cursor: number, ctx: PromptContext, analysis: Analysis = analyze(line, cursor, ctx)): string | null {
  if (cursor !== line.length) return null;
  if (line.trim() === "") return line === "" ? ctx.fix ?? null : null;
  return fromHistory(line, ctx.history) ?? fromFix(line, ctx.fix) ?? fromGrammar(line, cursor, ctx)
    ?? fromListed(line, analysis, ctx) ?? fromValue(line, analysis, ctx);
}
