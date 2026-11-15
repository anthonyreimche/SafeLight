// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// `doctor` on a terminal: a checklist with a mark a row, what to do about a
// row under it, and a verdict as the last line.

import { lamp } from "../components/lamp";
import { wrapText } from "../format";
import { joinDots } from "../look";
import type { Look } from "../look";
import type { DoctorItem } from "../types";
import { cells, padEnd } from "../width";

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * A value that ends by saying what its hint says ("not known yet: open
 * Safelight once" over "Open Safelight once so…") loses that ending here,
 * where the hint is shown right under it. The plain list has no hints and
 * keeps the value whole.
 */
function withoutHint(item: DoctorItem): string {
  const at = item.value.lastIndexOf(": ");
  if (at < 0 || !item.hint) return item.value;
  const tail = item.value.slice(at + 2).toLowerCase();
  return item.hint.toLowerCase().startsWith(tail) ? item.value.slice(0, at) : item.value;
}

/** `pending` are checks still running: each a lamp beside its label, under the rows that have settled, with no verdict yet. */
export function doctorLines(items: readonly DoctorItem[], look: Look, pending: readonly string[] = [], elapsedMs = 0): string[] {
  const { glyphs, theme } = look;
  const marks: Record<DoctorItem["status"], string> = {
    ok: theme.paint("ok", glyphs.ok),
    warn: theme.paint("amber", glyphs.warn),
    fail: theme.paint("lamp", glyphs.fail),
    info: theme.paint("faint", glyphs.none),
  };
  const markWidth = Math.max(...Object.values(marks).map(cells));
  const labelWidth = Math.max(0, ...items.map((item) => cells(item.label)), ...pending.map(cells));
  const hang = markWidth + 1 + labelWidth + 3;
  const room = Math.max(20, look.width - hang);

  const rows = items.flatMap((item) => {
    const value = wrapText(glyphs.fold(withoutHint(item)), room);
    const hint = item.hint ? wrapText(glyphs.fold(item.hint), room).map((line) => theme.paint("muted", line)) : [];
    const head = `${padEnd(marks[item.status], markWidth)} ${theme.paint("muted", padEnd(item.label, labelWidth))}   `;
    return [...value, ...hint].map((line, i) => (i === 0 ? head : " ".repeat(hang)) + line);
  });

  if (pending.length > 0) {
    return [...rows, ...pending.map((label) => `${padEnd(lamp(elapsedMs, look), markWidth)} ${theme.paint("muted", label)}`)];
  }

  const problems = items.filter((item) => item.status === "fail").length;
  const notes = items.filter((item) => item.status === "warn").length;
  const verdict = problems + notes === 0
    ? theme.paint("ok", "Everything is in order.")
    : joinDots([
      problems > 0 ? theme.paint("lamp", plural(problems, "problem", "problems")) : "",
      notes > 0 ? theme.paint("amber", plural(notes, "note", "notes")) : "",
    ], look);
  return [...rows, "", verdict];
}
