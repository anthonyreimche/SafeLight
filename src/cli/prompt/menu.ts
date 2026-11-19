// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The tab menu: what fits the word at the cursor, under the line. Typing
// narrows it; enter takes the selected one into the line without running it.

import { complete, type Candidate, type Completion } from "../complete";
import type { PromptContext } from "./context";
import { analyze, isPhotoWord, SET_WORDS } from "./grammar";
import type { MenuView } from "./view";

export const MENU_ROWS = 6;

export interface MenuState { start: number; end: number; items: readonly Candidate[]; selected: number }

/** What fits at the cursor: the completion, with `@` and `@all` first in a photo slot while a set is open. */
export function completeAt(line: string, cursor: number, ctx: PromptContext): Completion {
  const completion = complete(line, cursor, ctx);
  const { working, current } = ctx;
  if (!working || !current || !completion.typed.startsWith("@")) return completion;
  const word = analyze(line, cursor, ctx).at;
  if (!word || !isPhotoWord(word)) return completion;
  const name = current.rel.slice(current.rel.lastIndexOf("/") + 1);
  const detail = (text: string): string => (text === "@" ? name : `the ${working.rels.length} open`);
  const words = SET_WORDS.filter((w) => w.startsWith(completion.typed)).map((text): Candidate => ({ text, label: text, detail: detail(text) }));
  return { ...completion, items: [...words, ...completion.items] };
}

/** The menu for the word at the cursor, or null when nothing fits. */
export function menuAt(line: string, cursor: number, ctx: PromptContext): MenuState | null {
  const { start, end, items } = completeAt(line, cursor, ctx);
  return items.length === 0 ? null : { start, end, items, selected: 0 };
}

export function menuView(menu: MenuState): MenuView {
  return {
    items: menu.items.map(({ label, detail, group }) => ({ label, ...(detail !== undefined && { detail }), ...(group !== undefined && { group }) })),
    selected: menu.selected,
    rows: MENU_ROWS,
  };
}

/** A finished word gets a space after it; a folder, a `key=` or an open quote doesn't. */
const finished = (text: string): boolean => !/[\\/=]$/.test(text) && !/^["'][^"']*$/.test(text);

/** The line with `text` in place of [start, end). */
export function takeCandidate(line: string, start: number, end: number, text: string): { line: string; cursor: number } {
  const after = line.slice(end);
  const space = finished(text) && !after.startsWith(" ") ? " " : "";
  const next = line.slice(0, start) + text + space + after;
  return { line: next, cursor: start + text.length + (finished(text) ? 1 : 0) };
}

/** The longest start every candidate shares, as typed. */
export function commonStart(completion: Completion): string {
  const texts = completion.items.map((c) => c.text);
  let prefix = texts[0] ?? "";
  for (const text of texts) {
    let i = 0;
    while (i < prefix.length && i < text.length && prefix[i] === text[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix;
}
