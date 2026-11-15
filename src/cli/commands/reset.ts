// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PHOTO_OPTIONS } from "../args";
import { hasGlob } from "../glob";
import { currentLook } from "@/catalog/edit-steps";
import { freshParams, type DevelopParams } from "@/catalog/types";
import { CliError, type CommandContext, type CommandSpec, type ValueInfo } from "../types";
import { runOnPhotos, stepOutcome } from "./edit-shared";

/** Positionals that name a value are keys; the rest are photos. A word that is no
 *  file and is close to a key's name is a misspelt key, and says so. */
function splitKeys(ctx: CommandContext, positionals: string[]): { keys: ValueInfo[]; photos: string[] } {
  const keys: ValueInfo[] = [];
  const photos: string[] = [];
  for (const word of positionals) {
    try {
      keys.push(ctx.values.resolveKey(word));
    } catch (e) {
      if (!(e instanceof CliError)) throw e;
      const misspelt = e.hint?.startsWith("Did you mean") && !hasGlob(word) && !existsSync(resolve(ctx.env.cwd, word));
      if (misspelt) throw e;
      photos.push(word);
    }
  }
  return { keys, photos };
}

/** What a reset with no keys leaves alone: slu can't show or edit these, so wiping them would be blind. */
const KEPT_BY_RESET: readonly (readonly [keyof DevelopParams, string])[] = [
  ["toneCurve", "tone curve"], ["masks", "masks"], ["retouch", "retouch spots"], ["crop", "crop"], ["guidedLines", "guide lines"],
];

export const resetCommand: CommandSpec = {
  verb: "reset",
  group: "Edit",
  summary: "Resets the values named, or with no keys everything slu can set, in one step.",
  usage: "reset <photos> [key…]",
  examples: [
    "slu reset IMG_4021.ARW exposure contrast",
    "slu reset IMG_4021.ARW",
  ],
  options: [
    ...PHOTO_OPTIONS,
  ],
  writes: true,
  async run(ctx, args) {
    const { keys, photos } = splitKeys(ctx, args.positionals);
    const names = keys.map((k) => k.key);
    const label = keys.length === 0 ? "Reset" : `Reset ${keys.map((k) => k.label).join(", ")}`;
    const kept = new Set<string>();
    const outcome = await runOnPhotos(ctx, args, photos, false, ({ photo, state, asShot }) => {
      const look = ctx.values.resetKeys(currentLook(state, asShot), keys.length === 0 ? "all" : names, asShot);
      if (keys.length === 0) {
        const fresh = freshParams(asShot);
        for (const [key, name] of KEPT_BY_RESET) {
          if (JSON.stringify(look.params[key]) !== JSON.stringify(fresh[key])) kept.add(name);
        }
      }
      return stepOutcome(ctx, photo, state, asShot, look, label, []);
    });
    if (kept.size > 0 && !ctx.json) ctx.out.info(`Kept what slu can't edit: ${[...kept].join(", ")}. Edit those in Safelight.`);
    return outcome;
  },
};
