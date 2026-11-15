// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { PHOTO_OPTIONS } from "../args";
import { CliError, type CommandSpec, COMMAND } from "../types";
import { PREVIEW_OPTION } from "./shared";
import { currentLook } from "@/catalog/edit-steps";
import { runOnPhotos, stepOutcome } from "./edit-shared";

export const setCommand: CommandSpec = {
  verb: "set",
  group: "Edit",
  summary: "Sets values on each photo, one history step per photo.",
  usage: "set <photos> key=value…",
  examples: [
    `${COMMAND} set IMG_4021.ARW exposure=+0.7 highlights=-40 temperature=5600K`,
    `${COMMAND} set . --flag pick exposure+=0.3 vibrance=15`,
  ],
  options: [
    ...PHOTO_OPTIONS,
    PREVIEW_OPTION,
  ],
  writes: true,
  async run(ctx, args) {
    if (args.assignments.length === 0) {
      throw new CliError(1, "Give at least one value to set, like exposure=0.5.", `${COMMAND} help set shows how.`);
    }
    const warned = new Set<string>();
    return runOnPhotos(ctx, args, args.positionals, false, ({ photo, state, asShot }) => {
      const look = currentLook(state, asShot);
      const result = ctx.values.apply(look, args.assignments, { asShot, strict: ctx.strict });
      for (const c of result.changes) {
        if (!c.clamped || warned.has(c.info.key)) continue;
        warned.add(c.info.key);
        ctx.out.warn({ message: `${c.info.label} ${c.clamped.requested} is past its limit, so it was set to ${ctx.out.formatValue(c.info, c.after)}.` });
      }
      return stepOutcome(ctx, photo, state, asShot, result.look, result.label, result.changes);
    });
  },
};
