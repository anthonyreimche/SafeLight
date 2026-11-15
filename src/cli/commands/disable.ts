// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { CommandSpec } from "../types";
import { forEachName, needNames, noteRestart, resolveInstalled } from "./extension-names";

export const disableCommand: CommandSpec = {
  verb: "disable",
  group: "Extensions",
  summary: "Switches extensions off without uninstalling them.",
  usage: "disable <name>…",
  examples: [
    "slu disable contrast-equalizer",
  ],
  options: [],
  writes: false,
  async run(ctx, args) {
    needNames(args.positionals, "disable <name>…");
    const installed = await ctx.extensions.installed();
    const { results, outcome } = await forEachName(ctx, args.positionals, async (name) => {
      const ext = await resolveInstalled(ctx, name, installed);
      // Asked even when it reads as off: only the service knows whether that is known yet.
      await ctx.extensions.setEnabled(ext.id, false);
      return ext.enabled ? `${ext.name} is now off.` : `${ext.name} is already off.`;
    });
    if (ctx.json) ctx.out.json({ slu: 1, results });
    await noteRestart(ctx, results.some((r) => r.ok));
    return outcome;
  },
};
