// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { SEARCH_LIMIT } from "../extensions";
import type { CommandSpec } from "../types";
import { needNames } from "./extension-names";
import { COMMAND } from "../types";

export const searchCommand: CommandSpec = {
  verb: "search",
  group: "Extensions",
  summary: "Searches the extension registry by name, keywords and category.",
  usage: "search <words…>",
  examples: [
    `${COMMAND} search local contrast`,
  ],
  options: [],
  writes: false,
  async run(ctx, args) {
    needNames(args.positionals, "search <words…>");
    const hits = await ctx.extensions.search(args.positionals);
    if (ctx.json) {
      ctx.out.json({ slu: 1, results: hits });
      return { code: 0 };
    }
    if (hits.length === 0) {
      ctx.out.print(`Nothing found for "${args.positionals.join(" ")}".`);
      return { code: 0 };
    }
    ctx.out.print(ctx.out.searchTable(hits.map(({ installName, name, version, category, trust, description }) =>
      ({ installName, name, version, category, trust, description }))));
    if (hits.length >= SEARCH_LIMIT)
      ctx.out.warn({ message: `Showing the first ${SEARCH_LIMIT}.`, hint: "Add more words to narrow the search." });
    return { code: 0 };
  },
};
