// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { join } from "node:path";
import { PHOTO_OPTIONS } from "../args";
import type { PhotoRow } from "../output/types";
import { buildSelectRequest, isEdited, missingError, stdinPathsOf } from "../select";
import { type CommandSpec, COMMAND } from "../types";

function sizeText(bytes: number): string | undefined {
  if (!(bytes > 0)) return undefined;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

export const photosCommand: CommandSpec = {
  verb: "photos",
  group: "Look",
  summary: "Lists photos: name, rating, flag, label, edited or not, size.",
  usage: "photos [photos…] [filters]",
  examples: [
    `${COMMAND} photos --flag pick`,
    `${COMMAND} photos . --rating 4+ --json`,
  ],
  options: [
    ...PHOTO_OPTIONS,
  ],
  writes: false,
  async run(ctx, args) {
    const request = buildSelectRequest(args, args.positionals, await stdinPathsOf(ctx, args));
    const selection = await ctx.select.read(request);
    const rows: PhotoRow[] = [];
    const entries: Record<string, unknown>[] = [];
    try {
      for (const { session, photos } of selection.groups) {
        for (const photo of photos) {
          const edited = isEdited(await session.edit(photo.id));
          const size = sizeText(photo.fileSize);
          rows.push({
            name: photo.relPath,
            rating: photo.rating,
            flag: photo.flag,
            label: photo.colorLabel,
            edited,
            size,
          });
          entries.push({
            path: join(session.project.root, photo.relPath),
            project: session.project.root,
            relPath: photo.relPath,
            rating: photo.rating,
            flag: photo.flag,
            label: photo.colorLabel,
            edited,
            width: photo.width,
            height: photo.height,
            fileSize: photo.fileSize,
          });
        }
      }
    } finally {
      await selection.close();
    }

    // Nothing matching a filter is an answer ("0 photos"), not a failure.
    const problems = selection.missing.filter((m) => m.reason !== "no-match").map(missingError);
    if (!ctx.json) {
      if (rows.length > 0) ctx.out.print(ctx.out.photoTable(rows));
      ctx.out.print(ctx.out.summary({ photos: rows.length, stepEach: false, failed: 0, skipped: 0 }));
    }
    for (const p of problems) ctx.out.error({ message: p.message, hint: p.hint });
    const code = problems.length === 0 ? 0 : rows.length > 0 ? 6 : 2;
    return { code, json: { slu: 1, photos: entries } };
  },
};
