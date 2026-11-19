// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// `view`: one photo, live. Run once it shows the photo until Ctrl+C and follows
// the catalogue file, so edits from another `safelight` or from Safelight show
// up. At the prompt it is a toggle the prompt runs itself (live/prompt.ts).

import type { ViewTarget } from "../live/model";
import { startLiveView, type LiveViewOptions } from "../live/view";
import { selectOnePhoto } from "../select";
import { isGraphicsMode } from "../terminal-image";
import { CliError, type CliEnv, type CommandContext, type CommandSpec, type ParsedArgs, COMMAND } from "../types";
import { PROJECT_OPTION } from "./shared";

/** Where `view` shows the photo and how, from its options. */
export function viewSettings(env: CliEnv, args: ParsedArgs): LiveViewOptions {
  const { browser, terminal, port, width, graphics } = args.options;
  if (browser === true && terminal === true) throw new CliError(1, "--browser and --terminal both choose where to show it.", "Use one.");
  if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535)) {
    throw new CliError(1, "--port takes a port number up to 65535; 0 picks a free one.");
  }
  if (width !== undefined && (typeof width !== "number" || !(width >= 1))) throw new CliError(1, "--width takes a number of columns.");
  if (graphics !== undefined && (typeof graphics !== "string" || !isGraphicsMode(graphics))) {
    throw new CliError(1, `--graphics ${String(graphics)} isn't an image mode.`, "Use kitty, iterm, sixel, blocks or none.");
  }
  const mode = browser === true ? "browser" : terminal === true || env.isTTY.stdout ? "terminal" : "browser";
  return {
    mode,
    port: typeof port === "number" ? port : 0,
    open: args.options["no-open"] !== true,
    ...(typeof width === "number" && { widthCols: width }),
    ...(typeof graphics === "string" && isGraphicsMode(graphics) && { graphics }),
  };
}

/** The one photo `view` names, or the open one. */
export async function viewTarget(ctx: CommandContext, args: ParsedArgs): Promise<ViewTarget> {
  const one = await selectOnePhoto(ctx, args, args.positionals[0], { allMeansEverything: false });
  try {
    return { project: one.session.project, relPath: one.photo.relPath };
  } finally {
    await one.close();
  }
}

export const viewCommand: CommandSpec = {
  verb: "view",
  group: "Look",
  summary: "Shows a photo live, in the browser or the terminal, and shows it again each time it changes.",
  usage: "view [photo] [--browser | --terminal] [--port n] [--no-open]",
  examples: [
    `${COMMAND} view IMG_4021.ARW --browser`,
    `${COMMAND} view IMG_4021.ARW --terminal`,
  ],
  options: [
    PROJECT_OPTION,
    { name: "browser", kind: "flag", summary: "Show it in the default browser." },
    { name: "terminal", kind: "flag", summary: "Show it in the terminal, redrawn in place." },
    { name: "port", kind: "number", summary: "The port the browser's page is served on; any free one by default." },
    { name: "no-open", kind: "flag", summary: "Print the page's address without opening the browser." },
    { name: "width", kind: "number", summary: "The terminal picture's width in columns." },
    { name: "graphics", kind: "string", summary: "Image mode: kitty, iterm, sixel, blocks or none." },
  ],
  writes: false,
  ownsStop: true,
  async run(ctx, args) {
    if (ctx.json) throw new CliError(1, "view shows a picture, so --json has nothing to add.", `${COMMAND} tools --json prints the values.`);
    if (args.positionals[0] === "off") throw new CliError(1, "view off is for the prompt. Here Ctrl+C stops the view.");
    const settings = viewSettings(ctx.env, args);
    const target = await viewTarget(ctx, args);
    const view = await startLiveView(
      { env: ctx.env, out: ctx.out, engine: ctx.engine, projects: ctx.projects, values: ctx.values },
      settings,
      target,
    );
    try {
      if (view.url !== null) {
        ctx.out.print(`Live view: ${view.url}`);
        ctx.out.print("Ctrl+C stops it.");
      }
      const stops = ctx.stops;
      if (stops && !stops.signal.aborted) {
        await new Promise<void>((resolve) => stops.signal.addEventListener("abort", () => resolve(), { once: true }));
      }
      return { code: 0 };
    } finally {
      await view.stop();
      await ctx.engine().shutdown();
    }
  },
};
