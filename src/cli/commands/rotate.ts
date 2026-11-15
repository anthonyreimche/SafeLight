// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { normalizeRotation } from "@/catalog/orient";
import { PHOTO_OPTIONS } from "../args";
import type { CommandSpec } from "../types";
import { CliError, COMMAND } from "../types";
import { photoName, runOnPhotos } from "./edit-shared";

const TURNS: Record<string, { degrees: number; said: string }> = {
  right: { degrees: 90, said: "right" },
  cw: { degrees: 90, said: "right" },
  "90": { degrees: 90, said: "right" },
  left: { degrees: 270, said: "left" },
  ccw: { degrees: 270, said: "left" },
  "270": { degrees: 270, said: "left" },
  "-90": { degrees: 270, said: "left" },
  "180": { degrees: 180, said: "180°" },
};

export const rotateCommand: CommandSpec = {
  verb: "rotate",
  group: "Library",
  summary: "Turns photos left, right or 180°.",
  usage: "rotate <photos> left|right|180",
  examples: [
    `${COMMAND} rotate DSC_0412.NEF right`,
    `${COMMAND} rotate . --flag pick left`,
  ],
  options: [
    ...PHOTO_OPTIONS,
  ],
  writes: true,
  async run(ctx, args) {
    const word = args.positionals[args.positionals.length - 1];
    if (word === undefined) throw new CliError(1, "Say which way to turn: left, right or 180.");
    const turn = TURNS[word.toLowerCase()];
    if (!turn) throw new CliError(1, `A turn is left, right or 180, not "${word}".`);
    return runOnPhotos(ctx, args, args.positionals.slice(0, -1), false, ({ photo }) => {
      const before = normalizeRotation(photo.rotation ?? 0);
      const after = normalizeRotation(before + turn.degrees);
      const swap = turn.degrees !== 180;
      return {
        line: {
          photo: photoName(photo),
          changes: [{ label: "Rotation", value: `${after}°` }],
          note: `turned ${turn.said}`,
        },
        json: { changed: true, changes: [{ key: "rotation", before, after }] },
        photo: {
          ...photo,
          rotation: after,
          width: swap ? photo.height : photo.width,
          height: swap ? photo.width : photo.height,
        },
      };
    });
  },
};
