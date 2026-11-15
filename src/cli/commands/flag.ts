// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { PHOTO_OPTIONS } from "../args";
import type { CommandSpec } from "../types";
import { CliError, COMMAND } from "../types";
import type { FlagStatus } from "@/catalog/types";
import { setRecordField } from "./edit-shared";

export const flagCommand: CommandSpec = {
  verb: "flag",
  group: "Organize",
  summary: "Sets the flag: pick, reject or none.",
  usage: "flag <photos> pick|reject|none",
  examples: [
    `${COMMAND} flag DSC_0412.NEF reject`,
  ],
  options: [
    ...PHOTO_OPTIONS,
  ],
  writes: true,
  async run(ctx, args) {
    return setRecordField(ctx, args, "flag", (word): FlagStatus => {
      if (word !== "pick" && word !== "reject" && word !== "none") throw new CliError(1, `A flag is pick, reject or none, not "${word}".`);
      return word;
    }, "pick, reject or none");
  },
};
