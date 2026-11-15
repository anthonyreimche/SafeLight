// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { currentLook } from "@/catalog/edit-steps";
import { selectOnePhoto } from "../select";
import type { CommandSpec } from "../types";
import { asShotOf } from "./edit-shared";
import { PROJECT_OPTION } from "./shared";
import { namedRows, toolRows } from "./tools";

export const getCommand: CommandSpec = {
  verb: "get",
  group: "Look",
  summary: "Prints a photo's values, all of them or the ones named.",
  usage: "get <photo> [key…]",
  examples: [
    "slu get IMG_4021.ARW exposure temperature",
    "slu get IMG_4021.ARW --json",
  ],
  options: [
    PROJECT_OPTION,
  ],
  writes: false,
  async run(ctx, args) {
    const [spec, ...keys] = args.positionals;
    const infos = keys.map((k) => ctx.values.resolveKey(k));
    const one = await selectOnePhoto(ctx, args, spec);
    try {
      const { photo, session } = one;
      const asShot = asShotOf(photo);
      const state = await session.edit(photo.id);
      const look = currentLook(state, asShot);

      if (infos.length > 0) {
        const rows = namedRows(ctx, look, asShot, infos);
        if (!ctx.json) ctx.out.print(ctx.out.toolTable(rows));
        const values = Object.fromEntries(infos.map((info) => [info.key, ctx.values.read(look, info)]));
        return { code: 0, json: { slu: 1, photo: photo.relPath, values } };
      }

      if (!ctx.json) ctx.out.print(ctx.out.toolTable(toolRows(ctx, look, asShot, true)));
      const step = state?.stack[state.currentIndex];
      return {
        code: 0,
        json: {
          slu: 1,
          photo: photo.relPath,
          step: step ? state.currentIndex : null,
          label: step?.label ?? null,
          params: look.params,
          paramBag: look.paramBag,
        },
      };
    } finally {
      await one.close();
    }
  },
};
