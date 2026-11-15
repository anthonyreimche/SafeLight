// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { PHOTO_OPTIONS } from "../args";
import { missingError } from "../select";
import type { CommandContext, CommandOutcome, CommandSpec, ParsedArgs } from "../types";
import { COMMAND } from "../types";
import { photoName, runOnPhotos, selectRequest } from "./edit-shared";

const stringsOf = (value: string | boolean | number | string[] | undefined): string[] => (Array.isArray(value) ? value : []);

async function listKeywords(ctx: CommandContext, args: ParsedArgs): Promise<CommandOutcome> {
  const selection = await ctx.select.read(await selectRequest(ctx, args, args.positionals));
  const entries: { photo: string; ok: true; keywords: string[] }[] = [];
  const counts = new Map<string, number>();
  try {
    for (const { session, photos } of selection.groups) {
      for (const photo of photos) entries.push({ photo: photo.relPath, ok: true, keywords: photo.keywords });
      if (entries.length > 1) {
        for (const p of session.photos()) for (const k of p.keywords) counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
  } finally {
    await selection.close();
  }

  const project = [...counts].map(([keyword, count]) => ({ keyword, count })).sort((a, b) => b.count - a.count);
  if (!ctx.json) {
    const blocks = [
      entries.length > 0 ? ctx.out.keywordList(entries) : "",
      project.length > 0 ? ctx.out.keywordTable(project) : "",
    ].filter((block) => block !== "");
    if (blocks.length > 0) ctx.out.print(blocks.join("\n\n"));
  }
  const problems = selection.missing.filter((m) => m.reason !== "no-match").map(missingError);
  for (const p of problems) ctx.out.error({ message: p.message, hint: p.hint });
  const code = problems.length === 0 ? 0 : entries.length > 0 ? 6 : 2;
  return { code, json: { slu: 1, photos: entries, ...(counts.size > 0 ? { keywords: project } : {}) } };
}

export const keywordsCommand: CommandSpec = {
  verb: "keywords",
  group: "Library",
  summary: "Lists or changes keywords.",
  usage: "keywords <photos> [--add word,…] [--remove word,…]",
  examples: [
    `${COMMAND} keywords DSC_0412.NEF`,
    `${COMMAND} keywords . --flag pick --add "black sand" --add iceland`,
    `${COMMAND} keywords Day2/ -r --remove draft`,
  ],
  options: [
    ...PHOTO_OPTIONS,
    { name: "add", kind: "list", summary: "Adds these keywords, comma-separated; repeat for more." },
    { name: "remove", kind: "list", summary: "Removes these keywords, comma-separated; repeat for more." },
  ],
  writes: true,
  async run(ctx, args) {
    const add = stringsOf(args.options.add);
    const remove = new Set(stringsOf(args.options.remove));
    if (add.length === 0 && remove.size === 0) return listKeywords(ctx, args);

    return runOnPhotos(ctx, args, args.positionals, false, ({ photo }) => {
      const before = photo.keywords;
      const kept = before.filter((k) => !remove.has(k));
      const present = new Set(kept);
      const added: string[] = [];
      for (const k of add) {
        if (!present.has(k)) {
          present.add(k);
          added.push(k);
        }
      }
      const after = [...kept, ...added];
      const removed = before.filter((k) => remove.has(k));
      const json = { keywords: after, added, removed };
      if (added.length === 0 && removed.length === 0) {
        return { line: { photo: photoName(photo), changes: [], note: "no change" }, json: { ...json, changed: false }, skipped: true };
      }
      const said = [
        ...(added.length > 0 ? [`added ${added.join(", ")}`] : []),
        ...(removed.length > 0 ? [`removed ${removed.join(", ")}`] : []),
      ].join("; ");
      return {
        line: { photo: photoName(photo), changes: [], note: said },
        json: { ...json, changed: true, changes: [{ key: "keywords", before, after }] },
        photo: { ...photo, keywords: after },
      };
    });
  },
};
