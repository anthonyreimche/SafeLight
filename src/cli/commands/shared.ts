// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Options more than one verb takes, beyond args.ts's global and photo options.

import { CliError, type OptionSpec, type ParsedArgs } from "../types";

export const PROJECT_OPTION: OptionSpec = {
  name: "project", kind: "string", summary: "Use this project instead of the one the photo sits in.",
};

export const PREVIEW_OPTION: OptionSpec = {
  name: "preview", kind: "flag", summary: "Print the result in the terminal, for one photo.",
};

export const TOOLS_OPTION: OptionSpec = {
  name: "tools", kind: "list", summary: "Only these tools, comma-separated: basic,detail.",
};

export const TRY_OPTION: OptionSpec = {
  name: "try", kind: "flag", summary: "Render with the key=value values given, without storing them.",
};

/** key=value on a verb that only renders is a trial: say so rather than apply it unasked. */
export function requireTry(args: ParsedArgs): void {
  if (args.assignments.length > 0 && args.options.try !== true) {
    throw new CliError(1, `${args.assignments[0].raw} would change the render, and ${args.verb ?? "this verb"} stores nothing.`, "Add --try to render with it.");
  }
}
