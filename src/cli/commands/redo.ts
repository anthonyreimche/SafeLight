// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { PHOTO_OPTIONS } from "../args";
import type { CommandSpec } from "../types";
import { moveHistory } from "./edit-shared";
import { COMMAND } from "../types";

export const redoCommand: CommandSpec = {
  verb: "redo",
  group: "Edit",
  summary: "Moves forward n steps (default 1), as Redo does in Safelight.",
  usage: "redo <photos> [n]",
  examples: [
    `${COMMAND} redo IMG_4021.ARW`,
  ],
  options: [
    ...PHOTO_OPTIONS,
  ],
  writes: true,
  async run(ctx, args) {
    return moveHistory(ctx, args, 1);
  },
};
