// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { PHOTO_OPTIONS } from "../args";
import { currentLook } from "@/catalog/edit-steps";
import type { CommandSpec } from "../types";
import { PREVIEW_OPTION } from "./shared";
import { runOnPhotos, stepOutcome, toolOperand } from "./edit-shared";

export const removeCommand: CommandSpec = {
  verb: "remove",
  group: "Edit",
  summary: "Puts all of a tool's values back to their defaults in one step, so it no longer runs.",
  usage: "remove <photos> <tool>",
  examples: [
    "slu remove IMG_4021.ARW local-contrast",
  ],
  options: [
    ...PHOTO_OPTIONS,
    PREVIEW_OPTION,
  ],
  writes: true,
  async run(ctx, args) {
    const { tool, photos } = toolOperand(ctx, args);
    return runOnPhotos(ctx, args, photos, false, ({ photo, state, asShot }) => {
      const look = ctx.values.resetTool(currentLook(state, asShot), tool.id, asShot);
      return stepOutcome(ctx, photo, state, asShot, look, `Reset ${tool.name}`, []);
    });
  },
};
