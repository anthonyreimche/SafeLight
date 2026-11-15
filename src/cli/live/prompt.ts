// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// `view` at the prompt: a toggle the prompt keeps between lines. It shows the
// open photo, or the one named, on the prompt's warm engine, and after each
// line follows the open photo and shows what the line changed.

import path from "node:path";
import { parseArgs } from "../args";
import { viewCommand, viewSettings } from "../commands/view";
import type { EngineClient } from "../engine-client";
import type { Output } from "../output/types";
import { CliError, type CliEnv, type ProjectService, type ValueService, type WorkingSet } from "../types";
import type { ViewTarget } from "./model";
import { startLiveView, type LiveView, type LiveViewOptions } from "./view";

export interface PromptViewHost {
  env(): CliEnv;
  out(): Output;
  engine(): EngineClient;
  projects(): ProjectService;
  values(): ValueService;
  working(): WorkingSet | null;
  /** Moves through the open photos for the page; false when it can't. */
  step(by: 1 | -1): Promise<boolean>;
  /** Draws a terminal picture above the prompt's line; false while a command runs. */
  around(draw: () => void): boolean;
  /** The photo a `view` line names, found as a command finds it; null when it failed and said why. */
  resolve(words: string[]): Promise<ViewTarget | null>;
  start?: typeof startLiveView;
}

export interface PromptView {
  /** Runs a `view` line. */
  command(words: string[]): Promise<void>;
  /** After any other line `verb` led: follows the open photo, and shows what changed. */
  after(verb: string): Promise<void>;
  stop(): Promise<void>;
}

const FOLLOWS = new Set(["next", "prev", "open", "cd"]);

/** The project record the photo at `abs` is. */
async function targetAt(projects: ProjectService, abs: string, platform: NodeJS.Platform): Promise<ViewTarget | null> {
  const project = await projects.find(abs);
  if (!project) return null;
  const p = platform === "win32" ? path.win32 : path.posix;
  return { project, relPath: p.relative(project.root, abs) };
}

export function createPromptView(host: PromptViewHost): PromptView {
  let live: { view: LiveView; options: LiveViewOptions; pinned: boolean } | null = null;

  const openTarget = async (): Promise<ViewTarget | null> => {
    const set = host.working();
    const abs = set?.paths[set.index];
    return abs === undefined ? null : targetAt(host.projects(), abs, host.env().platform);
  };

  async function stop(say: boolean): Promise<void> {
    const was = live;
    live = null;
    if (!was) return;
    await was.view.stop();
    if (say) host.out().print("Live view off.");
  }

  async function start(options: LiveViewOptions, target: ViewTarget, pinned: boolean): Promise<void> {
    const env = host.env();
    const view = await (host.start ?? startLiveView)(
      {
        env,
        out: host.out(),
        engine: host.engine,
        projects: host.projects(),
        values: host.values(),
        working: host.working,
        async step(by) {
          if (!(await host.step(by))) return false;
          if (live && !live.pinned) await live.view.follow(await openTarget());
          return true;
        },
        around: host.around,
      },
      options,
      target,
    );
    live = { view, options, pinned };
    if (view.url !== null) {
      host.out().print(`Live view: ${view.url}`);
      host.out().print("view off stops it.");
    }
  }

  return {
    async command(words) {
      const out = host.out();
      try {
        const args = parseArgs(words, viewCommand);
        if (args.positionals[0] === "off") {
          if (live) await stop(true);
          else out.print("The live view is off.");
          return;
        }
        const options = viewSettings(host.env(), args);
        const named = args.positionals.length > 0;
        const chosen = Object.keys(args.options).length > 0;
        if (live && !named && !chosen) {
          await stop(true);
          return;
        }
        const target = named ? await host.resolve(words) : await openTarget();
        if (!target) {
          if (!named) out.error({ message: "No photo is open.", hint: "view <photo> shows one, or open some first." });
          return;
        }
        const same = live && live.options.mode === options.mode && live.options.port === options.port
          && live.options.widthCols === options.widthCols && live.options.graphics === options.graphics;
        if (live && same) {
          live.pinned = named;
          await live.view.follow(target);
          return;
        }
        await stop(false);
        await start(options, target, named);
      } catch (error) {
        if (!(error instanceof CliError)) throw error;
        out.error({ message: error.message, ...(error.hint !== undefined && { hint: error.hint }) });
      }
    },

    async after(verb) {
      if (!live) return;
      if (verb === "close" || !host.working() && !live.pinned) {
        await stop(true);
        return;
      }
      live.view.moved();
      if (FOLLOWS.has(verb) && !live.pinned) await live.view.follow(await openTarget());
      await live.view.changed();
    },

    stop: () => stop(false),
  };
}
