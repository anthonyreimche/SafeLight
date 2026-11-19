// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { CliError, type CommandSpec, COMMAND } from "../types";
import { PROJECT_OPTION, TOOLS_OPTION } from "./shared";
import { copyFromPhoto, toolsOf, writeClipboard } from "./share-support";

export const copyCommand: CommandSpec = {
  verb: "copy",
  group: "Share",
  summary: "Remembers a photo's settings for paste, leaving out the per-photo tools Paste Settings leaves out.",
  usage: "copy <photo> [--tools a,b]",
  examples: [
    `${COMMAND} copy IMG_4021.ARW`,
    `${COMMAND} copy IMG_4021.ARW --tools basic,white-balance`,
  ],
  options: [
    PROJECT_OPTION,
    TOOLS_OPTION,
  ],
  writes: false,
  async run(ctx, args) {
    const specs = [...args.positionals, ...args.afterDashDash];
    if (specs.length > 1) throw new CliError(1, "copy takes one photo.", `${COMMAND} help copy shows how.`);
    const tools = toolsOf(args.options.tools);
    const clip = await copyFromPhoto(ctx, args, specs[0], tools);
    await writeClipboard(ctx.env.userData, clip);
    const fields = Object.keys(clip.look.params).length + Object.keys(clip.look.paramBag).length;
    if (ctx.json) ctx.out.json({ slu: 1, from: clip.from, values: fields });
    else ctx.out.print(`Copied ${fields} settings from ${clip.from}.`);
    return { code: 0 };
  },
};
