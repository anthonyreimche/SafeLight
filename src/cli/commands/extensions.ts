// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { CliError, type CommandSpec } from "../types";

export const extensionsCommand: CommandSpec = {
  verb: "extensions",
  group: "Extensions",
  summary: "Lists installed extensions: name, id, version, on or off, trust, update available.",
  usage: "extensions",
  examples: [
    "slu extensions",
  ],
  options: [],
  writes: false,
  async run(ctx) {
    const installed = await ctx.extensions.installed();
    const updates = new Map<string, string>();
    try {
      for (const u of await ctx.extensions.updatesAvailable()) updates.set(u.id, u.to);
    } catch (e) {
      if (!(e instanceof CliError)) throw e;
      ctx.out.warn({ message: `Couldn't check for updates. ${e.message}`, hint: e.hint });
    }
    if (ctx.json) {
      ctx.out.json({
        slu: 1,
        extensions: installed.map((e) => ({ ...e, update: updates.get(e.id) ?? null })),
      });
      return { code: 0 };
    }
    if (installed.length === 0) {
      ctx.out.print("No extensions are installed.");
      return { code: 0 };
    }
    ctx.out.print(ctx.out.extensionTable(installed.map((e) => ({
      name: e.name, id: e.id, version: e.version, enabled: e.enabled, trust: e.trust, update: updates.get(e.id),
    }))));
    return { code: 0 };
  },
};
