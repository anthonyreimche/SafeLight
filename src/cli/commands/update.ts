// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { CliError, type CommandSpec, type InstallRisk, type InstalledExtension } from "../types";
import { forEachName, noteRestart, resolveInstalled } from "./extension-names";
import { confirmFor } from "./install";

export const updateCommand: CommandSpec = {
  verb: "update",
  group: "Extensions",
  summary: "Updates the named extensions, or all with a newer release.",
  usage: "update [name…]",
  examples: [
    "slu update",
    "slu update local-contrast",
  ],
  options: [],
  writes: false,
  async run(ctx, args) {
    const installed = await ctx.extensions.installed();
    const named: InstalledExtension[] = [];
    let unresolved = 0;
    for (const name of args.positionals) {
      try {
        named.push(await resolveInstalled(ctx, name, installed));
      } catch (e) {
        if (!(e instanceof CliError)) throw e;
        unresolved++;
        ctx.out.error({ message: e.message, hint: e.hint });
      }
    }
    const wantSome = args.positionals.length > 0;
    const pending = wantSome && named.length === 0
      ? []
      : await ctx.extensions.updatesAvailable(wantSome ? named.map((e) => e.id) : undefined);
    if (pending.length === 0) {
      if (unresolved === 0 && !ctx.json) ctx.out.print("Everything is up to date.");
      if (ctx.json) ctx.out.json({ slu: 1, results: [] });
      return { code: unresolved > 0 ? 5 : 0 };
    }
    const byId = new Map(pending.map((p) => [p.id, p]));
    const { results, outcome } = await forEachName(ctx, pending.map((p) => p.id), async (id) => {
      const ext = installed.find((e) => e.id === id);
      const update = byId.get(id);
      if (!ext?.repo || !update) throw new CliError(5, `${id} has no repository to update from.`);
      const known = new Set(ext.permissions);
      const askAboutMore = confirmFor(ctx, undefined, true);
      const confirm = async (risk: InstallRisk): Promise<boolean> => {
        const added = risk.permissions.filter((p) => !known.has(p));
        return added.length === 0 || askAboutMore({ ...risk, permissions: added });
      };
      const now = await ctx.extensions.install(ext.repo, { confirm });
      return `Updated ${now.name} from ${update.from} to ${now.version}.`;
    });
    if (ctx.json) ctx.out.json({ slu: 1, results });
    await noteRestart(ctx, results.some((r) => r.ok));
    return { code: unresolved > 0 ? 5 : outcome.code };
  },
};
