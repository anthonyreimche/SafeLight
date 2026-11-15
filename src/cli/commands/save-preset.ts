// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { CliError, type CommandSpec } from "../types";
import { PROJECT_OPTION, TOOLS_OPTION } from "./shared";

export const savePresetCommand: CommandSpec = {
  verb: "save-preset",
  group: "Share",
  summary: "Saves a preset from a photo.",
  usage: "save-preset <name> <photo> [--tools a,b] [--group G]",
  examples: [
    "slu save-preset \"Warm film\" IMG_4021.ARW --group Film",
  ],
  options: [
    PROJECT_OPTION,
    TOOLS_OPTION,
    { name: "group", kind: "string", summary: "The preset group." },
  ],
  writes: false,
  async run() {
    throw new CliError(1, "save-preset isn't in this release yet. Save presets in Safelight.");
  },
};
