// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { CURRENT_PROCESS_VERSION } from "@/catalog/process-version";
import type { CommandSpec } from "../types";

export const versionCommand: CommandSpec = {
  verb: "version",
  group: "More",
  summary: "Prints the version. Same as --version.",
  usage: "version",
  examples: [
    "slu version",
  ],
  options: [],
  writes: false,
  async run(ctx) {
    const version = ctx.env.appVersion;
    if (!ctx.json) ctx.out.print(`Safelight Unplugged ${version} (process version ${CURRENT_PROCESS_VERSION})`);
    return { code: 0, json: { slu: 1, version, processVersion: CURRENT_PROCESS_VERSION } };
  },
};
