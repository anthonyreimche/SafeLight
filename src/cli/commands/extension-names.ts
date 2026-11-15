// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What the extension verbs share: turning typed names into installed
// extensions, running a list of names without stopping at the first failure,
// and the note that the app picks changes up when it next starts.

import { CliError, type CommandContext, type CommandOutcome, type InstalledExtension, COMMAND } from "../types";

export const RESTART_NOTE = "Takes effect when Safelight next starts.";

/** The installed extension `name` means, or CliError(5). */
export async function resolveInstalled(
  ctx: CommandContext,
  name: string,
  installed: readonly InstalledExtension[],
): Promise<InstalledExtension> {
  const hit = await ctx.extensions.resolve(name);
  if ("kit" in hit) throw new CliError(5, `"${name}" is a kit, not one extension.`, "Name the extensions in it instead.");
  const found = installed.find((e) =>
    (hit.id !== undefined && e.id === hit.id) || (hit.repo !== "" && e.repo?.toLowerCase() === hit.repo.toLowerCase()));
  if (!found) throw new CliError(5, `${name} isn't installed.`, `${COMMAND} extensions lists what is.`);
  return found;
}

export interface NameResult { name: string; ok: boolean; message: string }

/** Runs `each` for every name, reports a failure and carries on, and settles the exit code. */
export async function forEachName(
  ctx: CommandContext,
  names: readonly string[],
  each: (name: string) => Promise<string>,
): Promise<{ results: NameResult[]; outcome: CommandOutcome }> {
  const results: NameResult[] = [];
  for (const name of names) {
    try {
      const message = await each(name);
      results.push({ name, ok: true, message });
      if (!ctx.json) ctx.out.print(message);
    } catch (e) {
      if (!(e instanceof CliError)) throw e;
      results.push({ name, ok: false, message: e.message });
      if (!ctx.json) ctx.out.error({ message: e.message, hint: e.hint });
    }
  }
  return { results, outcome: { code: results.some((r) => !r.ok) ? 5 : 0 } };
}

export async function noteRestart(ctx: CommandContext, changed: boolean): Promise<void> {
  if (changed && !ctx.json && (await ctx.extensions.guiRunning())) ctx.out.print(RESTART_NOTE);
}

export function needNames(names: readonly string[], usage: string): void {
  if (names.length === 0) throw new CliError(1, "Name at least one extension.", `Usage: ${COMMAND} ${usage}`);
}
