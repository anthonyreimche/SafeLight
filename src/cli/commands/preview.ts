// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { asShotOf, lookAtStep } from "../preview";
import { lookKey } from "../preview-cache";
import { applyWorkingSet, buildSelectRequest, missingError, stdinPathsOf } from "../select";
import { isGraphicsMode } from "../terminal-image";
import { CliError, type CommandSpec, type GraphicsMode, COMMAND } from "../types";
import { PROJECT_OPTION, TRY_OPTION, requireTry } from "./shared";

export const previewCommand: CommandSpec = {
  verb: "preview",
  group: "Look",
  summary: "Prints the edited photo in the terminal, then exits.",
  usage: "preview <photo> [--width cols] [--before | --step n] [--try key=value…]",
  examples: [
    `${COMMAND} preview IMG_4021.ARW --before`,
    `${COMMAND} preview IMG_4021.ARW`,
    `${COMMAND} preview IMG_4021.ARW --try exposure=+0.5 --width 100`,
  ],
  options: [
    PROJECT_OPTION,
    { name: "width", kind: "number", summary: "Width in terminal columns." },
    { name: "graphics", kind: "string", summary: "Image mode: kitty, iterm, sixel, blocks or none." },
    TRY_OPTION,
    { name: "before", kind: "flag", summary: "Show the photo as it was at its first step." },
    { name: "step", kind: "number", summary: "Show the photo at this history step, counted from 1." },
  ],
  writes: false,
  async run(ctx, args) {
    if (ctx.json) throw new CliError(1, "preview prints an image, so --json has nothing to add.", `${COMMAND} export writes the image to a file.`);
    const graphics = args.options.graphics;
    if (graphics !== undefined && (typeof graphics !== "string" || !isGraphicsMode(graphics))) {
      throw new CliError(1, `--graphics ${String(graphics)} isn't an image mode.`, "Use kitty, iterm, sixel, blocks or none.");
    }
    requireTry(args);
    const width = args.options.width;
    if (width !== undefined && (typeof width !== "number" || !(width >= 1))) throw new CliError(1, "--width takes a number of columns.");

    const step = args.options.step;
    if (step !== undefined && (typeof step !== "number" || !Number.isInteger(step) || step < 1)) {
      throw new CliError(1, "--step takes a step number, counted from 1.", `${COMMAND} history lists the steps.`);
    }
    const before = args.options.before === true;
    if (before && step !== undefined) throw new CliError(1, "--before and --step both choose a step.", "Use one.");
    if ((before || step !== undefined) && args.assignments.length > 0) {
      throw new CliError(1, "--try changes the current look, so it can't be combined with --before or --step.");
    }

    const request = applyWorkingSet(buildSelectRequest(args, args.positionals, await stdinPathsOf(ctx, args)), ctx.working);
    const selection = await ctx.select.read(request);
    try {
      const miss = selection.missing[0];
      if (miss) throw missingError(miss);
      const photos = selection.groups.flatMap((g) => g.photos.map((photo) => ({ photo, project: g.session.project })));
      if (photos.length === 0) throw new CliError(2, "No photo to preview.", `${COMMAND} preview takes one photo.`);
      if (photos.length > 1) throw new CliError(1, "preview shows one photo at a time.", "Name the one you want.");
      const [{ photo, project }] = photos;
      const state = await selection.groups[0].session.edit(photo.id);
      const atStep = before || step !== undefined ? lookAtStep(state, before ? 1 : (step as number), asShotOf(photo)) : null;
      await ctx.preview.show(project, photo, {
        widthCols: typeof width === "number" ? width : undefined,
        tryAssigns: args.assignments,
        mode: graphics as GraphicsMode | undefined,
        overrides: atStep?.overrides,
        look: lookKey(photo, state),
      });
      if (atStep) ctx.out.print(`${before ? "before · " : ""}step ${atStep.step} of ${atStep.of}`);
      return { code: 0 };
    } finally {
      await selection.close();
      await ctx.engine().shutdown();
    }
  },
};
