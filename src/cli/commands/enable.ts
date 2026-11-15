// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { CommandSpec } from "../types";
import { forEachName, needNames, noteRestart, resolveInstalled } from "./extension-names";

export const enableCommand: CommandSpec = {
  verb: "enable",
  group: "Extensions",
  summary: "Switches extensions on, the same switch as Safelight's.",
  usage: "enable <name>…",
  examples: [
    "slu enable contrast-equalizer",
  ],
  options: [],
  writes: false,
  async run(ctx, args) {
    needNames(args.positionals, "enable <name>…");
    const installed = await ctx.extensions.installed();
    const { results, outcome } = await forEachName(ctx, args.positionals, async (name) => {
      const ext = await resolveInstalled(ctx, name, installed);
      // Asked even when it reads as on: only the service knows whether that is known yet.
      await ctx.extensions.setEnabled(ext.id, true);
      return ext.enabled ? `${ext.name} is already on.` : `${ext.name} is now on.`;
    });
    if (ctx.json) ctx.out.json({ slu: 1, results });
    await noteRestart(ctx, results.some((r) => r.ok));
    return outcome;
  },
};
