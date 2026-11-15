// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { PHOTO_OPTIONS } from "../args";
import { currentLook } from "@/catalog/edit-steps";
import type { CatalogPhoto } from "@/catalog/types";
import { CliError, type CommandSpec, type ProjectRef } from "../types";
import { PREVIEW_OPTION } from "./shared";
import { asShotOf, photoName, selectRequest, toolOperand } from "./edit-shared";

export const addCommand: CommandSpec = {
  verb: "add",
  group: "Edit",
  summary: "Turns a tool on: writes its \"on\" values, if it has any.",
  usage: "add <photos> <tool>",
  examples: [
    "slu add IMG_4021.ARW local-contrast",
  ],
  options: [
    ...PHOTO_OPTIONS,
    PREVIEW_OPTION,
  ],
  writes: true,
  async run(ctx, args) {
    const { tool, photos } = toolOperand(ctx, args);
    if (tool.kind === "extension") {
      throw new CliError(1, `${tool.name} doesn't support slu yet. Set it in Safelight.`);
    }
    // A core tool is on whenever one of its values moves: list its keys and write nothing.
    const selection = await ctx.select.read(await selectRequest(ctx, args, photos));
    let shown: { project: ProjectRef; photo: CatalogPhoto } | null = null;
    try {
      const photo = selection.groups[0]?.photos[0];
      const session = selection.groups[0]?.session;
      if (!photo || !session) {
        throw new CliError(2, "None of those photos could be found.", "slu photos lists the ones in a project.");
      }
      const look = currentLook(await session.edit(photo.id), asShotOf(photo));
      const asShot = asShotOf(photo);
      const infos = ctx.values.values(tool.id);
      if (ctx.json) {
        ctx.out.json({ slu: 1, tool: tool.id, wrote: false, keys: infos.map((i) => i.key) });
      } else {
        ctx.out.info(`${tool.name} is on whenever one of its values moves, so there is nothing to turn on.`);
        ctx.out.print(ctx.out.toolTable([{
          tool: tool.name,
          values: infos.map((info) => ({
            info,
            value: ctx.values.read(look, info),
            changed: !ctx.values.isDefault(look, info, asShot),
          })),
        }]));
        ctx.out.print(`${photoName(photo)} was not changed.`);
      }
      if (args.options.preview === true && !ctx.json) shown = { project: session.project, photo };
    } finally {
      await selection.close();
    }
    if (shown) await ctx.preview.show(shown.project, shown.photo, {});
    return { code: 0 };
  },
};
