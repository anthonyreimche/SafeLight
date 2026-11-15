// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { PHOTO_OPTIONS } from "../args";
import type { CommandSpec } from "../types";
import { PREVIEW_OPTION, TOOLS_OPTION } from "./shared";
import { copyFromPhoto, readClipboard, restrictToTools, toolsOf, writeLooks } from "./share-support";

export const pasteCommand: CommandSpec = {
  verb: "paste",
  group: "Share",
  summary: "Applies the copied settings, one step per photo.",
  usage: "paste <photos> [--tools a,b] [--from <photo>]",
  examples: [
    "slu paste *.ARW",
    "slu paste . --from IMG_4021.ARW --tools basic",
  ],
  options: [
    ...PHOTO_OPTIONS,
    TOOLS_OPTION,
    { name: "from", kind: "string", summary: "Copy from this photo and paste in one go." },
    PREVIEW_OPTION,
  ],
  writes: true,
  async run(ctx, args) {
    const specs = [...args.positionals, ...args.afterDashDash];
    const tools = toolsOf(args.options.tools);
    const from = args.options.from;
    const clip = typeof from === "string"
      ? await copyFromPhoto(ctx, args, from, tools)
      : await readClipboard(ctx.env.userData);
    const look = typeof from === "string" || !tools ? clip.look : restrictToTools(ctx, clip.look, tools);
    return writeLooks(ctx, args, specs, "Paste Settings", look);
  },
};
