// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { PHOTO_OPTIONS } from "../args";
import type { CommandSpec } from "../types";
import { CliError } from "../types";
import { setRecordField } from "./edit-shared";

export const rateCommand: CommandSpec = {
  verb: "rate",
  group: "Organize",
  summary: "Sets the star rating, 0 to 5.",
  usage: "rate <photos> <0-5>",
  examples: [
    "slu rate IMG_4021.ARW 4",
  ],
  options: [
    ...PHOTO_OPTIONS,
  ],
  writes: true,
  async run(ctx, args) {
    return setRecordField(ctx, args, "rating", (word) => {
      if (!/^[0-5]$/.test(word)) throw new CliError(1, `A rating is a number from 0 to 5, not "${word}".`);
      return Number(word);
    }, "a rating from 0 to 5");
  },
};
