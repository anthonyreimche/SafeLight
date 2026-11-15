// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { CatalogPhoto } from "@/catalog/types";
import { PHOTO_OPTIONS } from "../args";
import { formatForgetCard } from "../output";
import type { ForgetRisk } from "../output/types";
import { missingError } from "../select";
import type { CommandContext, CommandSpec, ParsedArgs, ReadSession, Selection } from "../types";
import { CliError, COMMAND } from "../types";
import { photoName, selectRequest } from "./edit-shared";

const quoted = (word: string): string => (/[\s"]/.test(word) ? `"${word}"` : word);

/** The command line as typed, with --yes: what goes ahead. */
function withYes(args: ParsedArgs): string {
  const options = Object.entries(args.options).flatMap(([name, value]) => {
    if (name === "yes" || name === "json") return [];
    if (value === true) return [`--${name}`];
    return (Array.isArray(value) ? value : [String(value)]).map((v) => `--${name} ${quoted(v)}`);
  });
  const photos = [...args.positionals, ...(args.afterDashDash.length > 0 ? ["--", ...args.afterDashDash] : [])];
  return [COMMAND, "forget", ...photos.map(quoted), ...options, "--yes"].join(" ");
}

/** The names of the selected photos whose removal loses edits, and how many photos are selected. */
async function riskOf(selection: Selection<ReadSession>): Promise<ForgetRisk> {
  const edited: string[] = [];
  let photos = 0;
  for (const group of selection.groups) {
    photos += group.photos.length;
    for (const photo of group.photos) if (await hasEdits(group.session, photo)) edited.push(photoName(photo));
  }
  return { photos, edited };
}

/** Whether to go ahead and lose edits: --yes says so, the prompt asks under the card, anything else refuses. */
async function confirmLoss(ctx: CommandContext, args: ParsedArgs, risk: ForgetRisk, mayAsk = true): Promise<void> {
  if (ctx.yes) return;
  if (ctx.ask && mayAsk) {
    const card = formatForgetCard(risk, ctx.out.options);
    const answer = await ctx.ask(`${card}Forget ${risk.photos === 1 ? "it" : "them"}? [y/N] `);
    if (/^y(es)?$/i.test(answer.trim())) return;
    throw new CliError(1, "Nothing was removed.");
  }
  const problem = ctx.out.forgetProblem({ ...risk, command: withYes(args) });
  throw new CliError(1, problem.message, problem.hint, problem.fix);
}

/** Whether the photo, or a virtual copy that goes with it, holds history that removal loses. */
async function hasEdits(session: ReadSession, photo: CatalogPhoto): Promise<boolean> {
  const members = [photo, ...session.photos().filter((p) => p.copyOf === photo.id)];
  for (const member of members) {
    const state = await session.edit(member.id);
    if (state !== undefined && state.stack.length > 1) return true;
  }
  return false;
}

export const forgetCommand: CommandSpec = {
  verb: "forget",
  group: "Library",
  summary: "Removes photos from the catalogue; the files stay.",
  usage: "forget <photos> [--yes]",
  examples: [
    `${COMMAND} forget DSC_0412.NEF`,
    `${COMMAND} forget . --rating 0 --flag reject --yes`,
  ],
  options: [
    ...PHOTO_OPTIONS,
  ],
  writes: true,
  async run(ctx, args) {
    const request = await selectRequest(ctx, args, args.positionals);
    // Asked before the write opens, so the writer lock is never held while someone thinks.
    const agreed = new Set<string>();
    if (!ctx.yes) {
      const looked = await ctx.select.read(request);
      let risk: ForgetRisk;
      try {
        risk = await riskOf(looked);
      } finally {
        await looked.close();
      }
      if (risk.edited.length > 0) await confirmLoss(ctx, args, risk);
      for (const name of risk.edited) agreed.add(name);
    }
    const selection = await ctx.select.write(request, ctx.waitSeconds);
    const results: Record<string, unknown>[] = [];
    let removed = 0;
    try {
      if (!ctx.yes) {
        const now = await riskOf(selection);
        // Edited since the question: those weren't agreed to.
        if (now.edited.some((name) => !agreed.has(name))) await confirmLoss(ctx, args, now, false);
      }
      for (const { session, photos } of selection.groups) {
        if (photos.length === 0) continue;
        await session.removePhotos(photos.map((p) => p.id));
        for (const photo of photos) {
          removed++;
          results.push({ photo: photo.relPath, ok: true, changed: true, changes: [], removed: true });
          if (!ctx.json) ctx.out.print(ctx.out.resultLine({ photo: photoName(photo), changes: [], note: "removed from the catalogue" }));
        }
      }
    } finally {
      await selection.close();
    }

    const problems = selection.missing.map(missingError);
    for (const p of problems) {
      ctx.out.error({ message: p.message, hint: p.hint });
      results.push({ photo: null, ok: false, error: p.message });
    }
    if (ctx.json) ctx.out.json({ slu: 1, photos: results });
    else if (removed > 1) ctx.out.print(`${removed} photos removed from the catalogue. Their files stay where they are.`);

    if (problems.length === 0) return { code: 0 };
    return { code: removed === 0 ? problems[0].code : 6 };
  },
};
