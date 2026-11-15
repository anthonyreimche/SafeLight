// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { PHOTO_OPTIONS } from "../args";
import { CliError, type CommandSpec } from "../types";
import { PREVIEW_OPTION } from "./shared";
import { loadPresets, writeLooks, type SavedPreset } from "./share-support";

function findPreset(presets: readonly SavedPreset[], input: string): SavedPreset {
  const wanted = input.toLowerCase();
  const byId = presets.filter((p) => p.id === input);
  const found = byId.length > 0 ? byId : presets.filter((p) => p.name.toLowerCase() === wanted);
  if (found.length === 1) return found[0];
  if (found.length > 1) {
    const names = found.map((p) => (p.group ? `${p.group} / ${p.name}` : p.name)).join(", ");
    throw new CliError(1, `"${input}" names more than one preset: ${names}.`, "Use the preset's id to pick one.");
  }
  throw new CliError(1, `"${input}" isn't one of the saved presets.`, "slu presets lists them.");
}

export const applyCommand: CommandSpec = {
  verb: "apply",
  group: "Share",
  summary: "Applies a preset over the current values, one step per photo.",
  usage: "apply <preset> <photos>",
  examples: [
    "slu apply \"Warm film\" *.ARW",
  ],
  options: [
    ...PHOTO_OPTIONS,
    PREVIEW_OPTION,
  ],
  writes: true,
  async run(ctx, args) {
    const [name, ...rest] = args.positionals;
    if (name === undefined) throw new CliError(1, "apply needs a preset name.", "slu presets lists them.");
    const preset = findPreset(loadPresets(ctx.env.userData), name);
    return writeLooks(ctx, args, [...rest, ...args.afterDashDash], "Preset", {
      params: preset.params,
      paramBag: preset.paramBag ?? {},
    });
  },
};
