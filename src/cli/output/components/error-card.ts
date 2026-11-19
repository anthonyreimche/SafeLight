// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Errors and notices. An error is a red mark and a red left bar, not a box:
// what happened, what to know, then the fix as something to run.

import { wrapText } from "../format";
import { paintCommand } from "../look";
import type { Look } from "../look";
import type { Problem } from "../types";

export function errorCard(problem: Problem, look: Look): string[] {
  const { glyphs, theme } = look;
  const room = look.width - 2;
  const bar = theme.paint("lamp", glyphs.errorBar);
  return [
    ...wrapText(glyphs.fold(problem.message), room).map((line, i) => `${i === 0 ? theme.paint("lamp", glyphs.fail) : bar} ${line}`),
    ...(problem.hint ? wrapText(glyphs.fold(problem.hint), room).map((line) => `${bar} ${theme.paint("muted", line)}`) : []),
    ...(problem.fix ? [`${theme.paint("lamp", glyphs.errorEnd)} ${paintCommand(glyphs.fold(problem.fix), look)}`] : []),
  ];
}

/** A line with a leading mark: ✓ for something done, ! for something to know. */
export function notice(kind: "ok" | "warn", problem: Problem, look: Look): string[] {
  const { glyphs, theme } = look;
  const mark = kind === "ok" ? glyphs.ok : glyphs.warn;
  const pad = " ".repeat(mark.length);
  const room = look.width - mark.length - 1;
  return [
    ...wrapText(glyphs.fold(problem.message), room).map((line, i) => `${i === 0 ? theme.paint(kind === "ok" ? "ok" : "amber", mark) : pad} ${line}`),
    ...(problem.hint ? wrapText(glyphs.fold(problem.hint), room).map((line) => `${pad} ${theme.paint("muted", line)}`) : []),
    ...(problem.fix ? [`${pad} ${paintCommand(glyphs.fold(problem.fix), look)}`] : []),
  ];
}
