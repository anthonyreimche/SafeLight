// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { createInterface } from "node:readline/promises";
import { CliError, type CommandContext, type CommandSpec, type InstallRisk, COMMAND } from "../types";
import { forEachName, needNames, noteRestart } from "./extension-names";

export type Ask = (question: string) => Promise<string>;

const askOnTerminal: Ask = async (question) => {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
};

/** The unverified-extension question: --yes answers it, a terminal asks it, anything else refuses.
 *  `update` asks the same question for the permissions an update adds. */
export function confirmFor(
  ctx: CommandContext,
  ask: Ask = askOnTerminal,
  update = false,
): (risk: InstallRisk) => Promise<boolean> {
  return async (risk) => {
    if (ctx.yes) return true;
    if (!ctx.env.isTTY.stdin) return false;
    const reach = risk.permissions.length > 0
      ? `It asks to ${risk.permissions.join(", ")}.`
      : "It asks for no special permissions.";
    const answer = await ask(update
      ? `${risk.name} isn't verified, and this update asks for more. ${reach}
Update it? [y/N] `
      : `${risk.name} isn't verified. Extensions run with full access to your photos and files. ${reach}
Install it? [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  };
}

export const installCommand: CommandSpec = {
  verb: "install",
  group: "Extensions",
  summary: "Installs extensions from their GitHub releases. Safelight picks them up on its next start.",
  usage: "install <name>… [--version X] [--yes]",
  examples: [
    `${COMMAND} install local-contrast`,
    `${COMMAND} install essentials`,
    `${COMMAND} install owner/repo --version 1.2.0 --yes`,
  ],
  options: [
    { name: "version", kind: "string", summary: "Install this release instead of the newest." },
  ],
  writes: false,
  async run(ctx, args) {
    needNames(args.positionals, "install <name>… [--version X] [--yes]");
    const version = typeof args.options.version === "string" ? args.options.version : undefined;
    const confirm = confirmFor(ctx);
    const installed = await ctx.extensions.installed();
    const have = (repo: string): boolean => installed.some((e) => e.repo?.toLowerCase() === repo.toLowerCase());

    const installRepo = async (repo: string): Promise<string> => {
      const ext = await ctx.extensions.install(repo, { version, confirm });
      return `Installed ${ext.name} ${ext.version}.`;
    };

    const { results, outcome } = await forEachName(ctx, args.positionals, async (name) => {
      const hit = await ctx.extensions.resolve(name);
      if ("kit" in hit) {
        if (version) throw new CliError(1, "--version doesn't apply to a kit.", "Install its extensions one at a time.");
        const missing = hit.repos.filter((r) => !have(r));
        if (missing.length === 0) return `Everything in ${hit.kit} is already installed.`;
        const lines: string[] = [];
        for (const repo of missing) lines.push(await installRepo(repo));
        return lines.join("\n");
      }
      if (!version && have(hit.repo)) return `${name} is already installed. ${COMMAND} update brings it up to date.`;
      return installRepo(hit.repo);
    });
    if (ctx.json) ctx.out.json({ slu: 1, results });
    await noteRestart(ctx, results.some((r) => r.ok));
    return outcome;
  },
};
