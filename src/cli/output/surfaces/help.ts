// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// `help` on a terminal: one screen in 24 rows. Verbs are strong because they
// are what you type, and the examples wear the prompt's colours, so help
// teaches the highlighting.

import type { HelpGroup } from "../../types";
import { COMMAND } from "../../types";
import { flowChunks, wrapText } from "../format";
import { flowDots, paintArgument, paintCommand } from "../look";
import type { Look } from "../look";
import type { HelpScreen, VerbHelp } from "../types";
import { padEnd } from "../width";

const HELP_GROUPS: readonly HelpGroup[] = ["Look", "Library", "Edit", "Share", "Organize", "Output", "Extensions", "More"];
const LABEL_COLUMN = Math.max(...HELP_GROUPS.map((group) => group.length)) + 3;

const TITLE = "Safelight Unplugged";
const DOCS = "https://github.com/anthonyreimche/SafeLight/blob/main/docs/user/unplugged.md";
const DOCS_SHOWN = "github.com/anthonyreimche/SafeLight";

export function helpLines(screen: HelpScreen, look: Look): string[] {
  const { glyphs, theme } = look;
  const room = look.width - LABEL_COLUMN;

  const row = (label: string, chunks: readonly string[], paint: (chunk: string) => string, gap = "  "): string[] =>
    flowChunks(chunks, gap, room).map((line, i) =>
      (i === 0 ? padEnd(theme.paint("muted", label), LABEL_COLUMN) : " ".repeat(LABEL_COLUMN)) + line.map(paint).join(gap));

  const strong = (text: string): string => theme.paint("strong", text);
  const value = (text: string): string => text.split(" ").map((word) => paintArgument(word, look)).join(" ");

  const groups = HELP_GROUPS.flatMap((group) => {
    const verbs = screen.verbs.filter((v) => v.group === group).map((v) => (v.verb === "help" ? "help <verb>" : v.verb));
    return verbs.length > 0 ? row(group, verbs, (verb) => paintCommand(verb, look)) : [];
  });

  return [
    ...flowDots([`${strong(TITLE)} ${theme.paint("muted", screen.version)}`, theme.paint("muted", "edit photos with commands and values")], look.width, look),
    "",
    ...flowChunks([COMMAND, "<verb>", `[photos${glyphs.ellipsis}]`, `[key=value${glyphs.ellipsis}]`, "[options]"], " ", look.width - 2)
      .map((line, i) => (i === 0 ? paintCommand(line.join(" "), look) : `  ${value(line.join(" "))}`)),
    "",
    ...groups,
    "",
    ...row("Photos", ["files", "*.ARW", "folders (-r)", "--all", "- for a list on stdin"], (chunk) => chunk, glyphs.dot),
    ...row("", ["--rating 3+", "--flag pick", "--label red", "--edited"], value),
    ...row("Values", ["key=5", "key+=0.3", "key-=10", "key=default", "temperature=5600K"], value),
    ...row("Options", ["--json", "-q", "-v", "--project <folder>", "--preview", "--yes", "--strict", "--wait"], value),
    "",
    ...flowDots([
      `${paintCommand("help <verb>", look)} ${theme.paint("muted", "shows one command")}`,
      `${theme.paint("muted", "docs:")} ${theme.link(DOCS, theme.paint("path", DOCS_SHOWN))}`,
    ], look.width, look),
  ];
}

export function verbHelpLines(v: VerbHelp, look: Look): string[] {
  const { glyphs, theme } = look;
  const usage = glyphs.fold(v.usage);
  const lines = [
    `${theme.paint("muted", COMMAND)} ${paintCommand(usage, look)}`,
    "",
    ...wrapText(glyphs.fold(v.summary), look.width),
  ];
  if (v.options.length > 0) {
    const flagColumn = Math.max(...v.options.map((o) => o.flag.length)) + 3;
    lines.push("");
    for (const option of v.options) {
      wrapText(glyphs.fold(option.summary), Math.max(20, look.width - flagColumn)).forEach((text, i) => {
        lines.push((i === 0 ? option.flag.padEnd(flagColumn) : " ".repeat(flagColumn)) + theme.paint("muted", text));
      });
    }
  }
  if (v.examples.length > 0) lines.push("", ...v.examples.map((example) => paintCommand(glyphs.fold(example), look)));
  return lines;
}
