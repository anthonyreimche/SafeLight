// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { CommandSpec } from "../types";
import { loadPresets } from "./share-support";

export const presetsCommand: CommandSpec = {
  verb: "presets",
  group: "Share",
  summary: "Lists the presets Safelight has saved, by group.",
  usage: "presets",
  examples: [
    "slu presets",
  ],
  options: [],
  writes: false,
  async run(ctx) {
    const presets = loadPresets(ctx.env.userData);
    if (ctx.json) {
      ctx.out.json({ slu: 1, presets: presets.map((p) => ({ id: p.id, name: p.name, group: p.group ?? null })) });
      return { code: 0 };
    }
    if (presets.length === 0) {
      ctx.out.print("No presets yet. Save one in Safelight and it shows here.");
      return { code: 0 };
    }
    const groups = new Map<string, string[]>();
    for (const p of presets) groups.set(p.group ?? "", [...(groups.get(p.group ?? "") ?? []), p.name]);
    for (const [group, names] of [...groups].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)))) {
      ctx.out.print(group === "" ? "Ungrouped" : group);
      for (const name of names) ctx.out.print(`  ${name}`);
    }
    return { code: 0 };
  },
};
