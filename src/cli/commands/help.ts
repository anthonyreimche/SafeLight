// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { VerbHelp } from "../output/types";
import { closest } from "../suggest";
import { CliError, type CommandSpec, type OptionSpec, COMMAND } from "../types";

function flagOf(option: OptionSpec): string {
  const long = `--${option.name}`;
  const named = option.alias ? `-${option.alias}, ${long}` : long;
  return option.kind === "flag" ? named : `${named} <value>`;
}

function verbHelpOf(spec: CommandSpec): VerbHelp {
  return {
    verb: spec.verb,
    usage: spec.usage,
    summary: spec.rawArgs ? `${spec.summary} Options go before ${spec.verb}; every word after it is its own, and photos come after --.` : spec.summary,
    options: spec.options.map((o) => ({ flag: flagOf(o), summary: o.summary })),
    examples: spec.examples,
  };
}

export const helpCommand: CommandSpec = {
  verb: "help",
  group: "More",
  summary: "Shows the help screen, or one verb's usage with examples.",
  usage: "help [verb]",
  examples: [
    `${COMMAND} help`,
    `${COMMAND} help set`,
  ],
  options: [],
  writes: false,
  async run(ctx, args) {
    // index.ts builds the registry from this file, so it is read once a verb runs.
    const index = await import("./index");
    const { NOT_IN_THIS_RELEASE, findCommand } = index;
    const COMMANDS = index.withExtensionVerbs(index.COMMANDS, ctx.env.userData);
    const word = args.positionals[0];
    if (word === undefined) {
      const verbs = COMMANDS.filter((c) => !NOT_IN_THIS_RELEASE.has(c.verb)).map(({ verb, group, summary }) => ({ verb, group, summary }));
      if (ctx.json) return { code: 0, json: { slu: 1, version: ctx.env.appVersion, verbs } };
      ctx.out.print(ctx.out.help({ version: ctx.env.appVersion, verbs }));
      return { code: 0 };
    }
    const spec = findCommand(COMMANDS, word);
    if (!spec) {
      const guess = closest(word, COMMANDS.flatMap((c) => [c.verb, ...(c.aliases ?? [])]));
      throw new CliError(
        1,
        guess ? `"${word}" isn't a ${COMMAND} verb. Did you mean ${guess}?` : `"${word}" isn't a ${COMMAND} verb.`,
        `${COMMAND} help lists them.`,
      );
    }
    const help = verbHelpOf(spec);
    if (ctx.json) return { code: 0, json: { slu: 1, ...help } };
    ctx.out.print(ctx.out.verbHelp(help));
    return { code: 0 };
  },
};
