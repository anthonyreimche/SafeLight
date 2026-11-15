// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { historyRows } from "@/catalog/edit-steps";
import { selectOnePhoto } from "../select";
import type { CommandSpec } from "../types";
import { PROJECT_OPTION } from "./shared";

export const historyCommand: CommandSpec = {
  verb: "history",
  group: "Look",
  summary: "Lists a photo's history steps with labels and times; the current one is marked.",
  usage: "history <photo>",
  examples: [
    "slu history IMG_4021.ARW",
  ],
  options: [
    PROJECT_OPTION,
  ],
  writes: false,
  async run(ctx, args) {
    const one = await selectOnePhoto(ctx, args, args.positionals[0]);
    try {
      const rows = historyRows(await one.session.edit(one.photo.id));
      if (!ctx.json) ctx.out.print(ctx.out.historyList(rows));
      return { code: 0, json: { slu: 1, photo: one.photo.relPath, steps: rows } };
    } finally {
      await one.close();
    }
  },
};
