// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { PHOTO_OPTIONS } from "../args";
import type { CommandSpec } from "../types";
import { CliError } from "../types";
import type { ColorLabel } from "@/catalog/types";
import { LABELS } from "../select";
import { setRecordField } from "./edit-shared";

export const labelCommand: CommandSpec = {
  verb: "label",
  group: "Organize",
  summary: "Sets the colour label.",
  usage: "label <photos> red|yellow|green|blue|purple|none",
  examples: [
    "slu label IMG_4021.ARW red",
  ],
  options: [
    ...PHOTO_OPTIONS,
  ],
  writes: true,
  async run(ctx, args) {
    return setRecordField(ctx, args, "colorLabel", (word): ColorLabel => {
      const found = LABELS.find((l) => l === word.toLowerCase());
      if (!found) throw new CliError(1, `A label is ${LABELS.join(", ")}, not "${word}".`);
      return found;
    }, LABELS.join(", "));
  },
};
