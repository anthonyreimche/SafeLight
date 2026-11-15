// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { CommandSpec } from "../types";
import { forEachName, needNames, noteRestart, resolveInstalled } from "./extension-names";
import { COMMAND } from "../types";

export const uninstallCommand: CommandSpec = {
  verb: "uninstall",
  group: "Extensions",
  summary: "Removes extensions. Photos keep their values.",
  usage: "uninstall <name>…",
  examples: [
    `${COMMAND} uninstall retinex`,
  ],
  options: [],
  writes: false,
  async run(ctx, args) {
    needNames(args.positionals, "uninstall <name>…");
    const installed = await ctx.extensions.installed();
    const { results, outcome } = await forEachName(ctx, args.positionals, async (name) => {
      const ext = await resolveInstalled(ctx, name, installed);
      await ctx.extensions.uninstall(ext.id);
      return `Removed ${ext.name}. Photos keep its values.`;
    });
    if (ctx.json) ctx.out.json({ slu: 1, results });
    await noteRestart(ctx, results.some((r) => r.ok));
    return outcome;
  },
};
