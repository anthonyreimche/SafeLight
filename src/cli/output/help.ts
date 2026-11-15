// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// `safelight help` and `safelight help <verb>`. The help screen fits one screen and keeps
// its shape at any width: a row that runs out of room continues under its own
// first word.

import type { HelpGroup } from "../types";
import { flowChunks, wrapText } from "./format";
import type { Style } from "./palette";
import type { HelpScreen, VerbHelp } from "./types";
import { COMMAND } from "../types";

const HELP_GROUPS: readonly HelpGroup[] = ["Look", "Library", "Edit", "Share", "Organize", "Output", "Extensions", "More"];
const GROUP_COLUMN = Math.max(...HELP_GROUPS.map((group) => group.length)) + 3;

const TITLE = "Safelight Unplugged";
const DOCS = "https://github.com/anthonyreimche/SafeLight/blob/main/docs/user/unplugged.md";

export function help(screen: HelpScreen, style: Style): string {
  const { palette, glyphs, width } = style;

  const row = (label: string, chunks: readonly string[], separator: string): string[] => {
    const name = label.trimEnd();
    const first = palette.dim(name) + " ".repeat(label.length - name.length);
    return flowChunks(chunks, separator, width - label.length).map(
      (line, i) => (i === 0 ? first : " ".repeat(label.length)) + line.join(separator),
    );
  };

  const groups = HELP_GROUPS.flatMap((group) => {
    const verbs = screen.verbs.filter((v) => v.group === group).map((v) => (v.verb === "help" ? "help <verb>" : v.verb));
    return verbs.length > 0 ? row(group.padEnd(GROUP_COLUMN), verbs, "   ") : [];
  });

  return [
    ...wrapText(`${TITLE} ${screen.version}: edit photos with commands and values.`, width)
      .map((line) => line.replace(TITLE, palette.heading(TITLE))),
    "",
    `  ${COMMAND} <verb> [photos${glyphs.ellipsis}] [key=value${glyphs.ellipsis}] [options]`,
    "",
    ...row("Photos: ", ["files,", "globs (*.ARW),", "folders (-r for subfolders),", "--all,", "- (paths on stdin)"], " "),
    ...row("        ", ["filters: --rating 3+", "--flag pick", "--label red", "--edited"], "  "),
    ...row("Values: ", ["key=5", "key+=0.3", "key-=10", "key=default", "temperature=5600K", "transform.flipH=on"], "  "),
    "",
    ...groups,
    "",
    ...row("Options: ", ["--json", "-q", "-v", "--project <folder>", "--preview", "--yes", "--strict", "--wait"], "  "),
    ...row("Docs: ", [DOCS], " "),
  ].join("\n");
}

export function verbHelp(v: VerbHelp, style: Style): string {
  const { palette, glyphs, width } = style;
  const usage = glyphs.fold(v.usage);
  const named = usage === v.verb || usage.startsWith(`${v.verb} `);
  const lines = [
    named ? `${palette.heading(`${COMMAND} ${v.verb}`)}${usage.slice(v.verb.length)}` : `${palette.heading(COMMAND)} ${usage}`,
    "",
    ...wrapText(glyphs.fold(v.summary), width),
  ];

  if (v.options.length > 0) {
    const flagColumn = Math.max(...v.options.map((o) => o.flag.length)) + 4;
    lines.push("", palette.dim("Options:"));
    for (const option of v.options) {
      const summary = wrapText(glyphs.fold(option.summary), Math.max(20, width - flagColumn));
      summary.forEach((text, i) => {
        lines.push(i === 0 ? `  ${option.flag.padEnd(flagColumn - 2)}${text}` : " ".repeat(flagColumn) + text);
      });
    }
  }
  if (v.examples.length > 0) {
    lines.push("", palette.dim("Examples:"), ...v.examples.map((example) => `  ${glyphs.fold(example)}`));
  }
  return lines.map((line) => line.trimEnd()).join("\n");
}
