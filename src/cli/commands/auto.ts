// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { PHOTO_OPTIONS } from "../args";
import { CliError, type CommandSpec, COMMAND } from "../types";
import { PREVIEW_OPTION } from "./shared";

export const autoCommand: CommandSpec = {
  verb: "auto",
  group: "Edit",
  summary: "Runs Basic's Auto Tone and White Balance's Auto, one step each.",
  usage: "auto <photos> [tone|wb]",
  examples: [
    `${COMMAND} auto IMG_4021.ARW`,
    `${COMMAND} auto . wb`,
  ],
  options: [
    ...PHOTO_OPTIONS,
    PREVIEW_OPTION,
  ],
  writes: true,
  async run() {
    throw new CliError(1, "auto isn't in this release yet. Use Auto in Safelight.");
  },
};
