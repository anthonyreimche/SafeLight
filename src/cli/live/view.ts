// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A live view: one photo, shown in the browser through the live view's server
// or redrawn in place in the terminal, and shown again whenever it changes. A
// change comes from this process (the command that made it says so) or from the
// catalogue file (another command, or the app). The engine renders every frame;
// one render at a time, the newest ask first.

import path from "node:path";
import type { EngineClient } from "../engine-client";
import type { Output } from "../output/types";
import { previewFrameSize } from "../preview";
import { catalogueStamp, type CachedFrame } from "../preview-cache";
import { detectGraphicsMode, encodeForTerminal, supportsTrueColour, type DetectedMode } from "../terminal-image";
import { CliError, type CliEnv, type GraphicsMode, type ProjectService, type ValueService, type WorkingSet, COMMAND } from "../types";
import { openBrowser } from "./browser";
import { createLatestWins } from "./frames";
import { createLiveModel, type LiveModel, type LiveWorking, type ViewTarget } from "./model";
import { APP_CSS, APP_JS, PAGE_HTML } from "./page";
import { frameAskKey, renderViewed, type FrameAsk } from "./render";
import { startLiveServer, type LiveServer, type LiveSource, type PageAssets } from "./server";
import { watchCatalogue, type Watch } from "./sync";
import { createTerminalLive, pictureRows } from "./terminal";

export type ViewMode = "browser" | "terminal";

export interface LiveViewOptions {
  mode: ViewMode;
  /** 0 picks a free port. */
  port: number;
  /** Opens the default browser on the URL. */
  open: boolean;
  /** The terminal picture's width in columns. */
  widthCols?: number;
  graphics?: GraphicsMode;
}

export interface LiveViewDeps {
  env: CliEnv;
  out: Output;
  engine(): EngineClient;
  projects: Pick<ProjectService, "openRead">;
  values: ValueService;
  /** The prompt's open photos, which the page lists. */
  working?(): WorkingSet | null;
  /** Moves through the open photos for the page's next and prev; false when it can't. */
  step?(by: 1 | -1): Promise<boolean>;
  /** Draws a terminal picture around whatever else holds the screen; false when it can't now. */
  around?(draw: () => void): boolean;
  openBrowser?(url: string): void;
  watch?: Watch;
  debounceMs?: number;
  catalogueStamp?(workingDir: string): Promise<string | undefined>;
  assets?: PageAssets;
  detect?(): Promise<DetectedMode>;
}

export interface LiveView {
  readonly mode: ViewMode;
  /** The page's address, in browser mode. */
  readonly url: string | null;
  readonly model: LiveModel;
  /** Shows `target` from now on. */
  follow(target: ViewTarget | null): Promise<void>;
  /** This process changed the catalogue: read it again now. */
  changed(): Promise<void>;
  /** Something was printed below the terminal picture. */
  moved(): void;
  /** Resolves once the terminal picture asked for so far is drawn. */
  settled(): Promise<void>;
  stop(): Promise<void>;
}

const PAGE: PageAssets = { html: PAGE_HTML, js: APP_JS, css: APP_CSS };

function workingOf(set: WorkingSet | null | undefined, platform: NodeJS.Platform): LiveWorking | null {
  if (!set) return null;
  const p = platform === "win32" ? path.win32 : path.posix;
  return { at: set.index + 1, of: set.paths.length, names: set.paths.map((abs) => p.basename(abs)) };
}

export async function startLiveView(deps: LiveViewDeps, options: LiveViewOptions, target: ViewTarget | null): Promise<LiveView> {
  const { env, out } = deps;
  const model = createLiveModel({
    projects: deps.projects,
    values: deps.values,
    formatValue: (info, value) => out.formatValue(info, value),
    catalogueStamp: deps.catalogueStamp ?? catalogueStamp,
    working: () => workingOf(deps.working?.(), env.platform),
  });
  const frames = createLatestWins<CachedFrame>();

  /** Renders `ask` of the photo as it is when the render starts, which may be newer than when it was asked. */
  const render = (ask: FrameAsk) => async (): Promise<CachedFrame> => {
    const viewed = model.viewed();
    if (!viewed) throw new CliError(2, "No photo to show.");
    try {
      const frame = await renderViewed(deps.engine(), viewed, ask);
      model.setEngine("ready");
      return frame;
    } catch (error) {
      if (!(error instanceof CliError) || error.code !== 2) model.setEngine("failed");
      throw error;
    }
  };

  let stopWatching = (): void => {};
  let watchedDir: string | null = null;
  const watchFor = (next: ViewTarget | null): void => {
    const dir = next?.project.workingDir ?? null;
    if (dir === watchedDir) return;
    stopWatching();
    watchedDir = dir;
    stopWatching = dir === null ? () => {} : watchCatalogue(dir, () => { void model.refresh(); }, {
      ...(deps.watch && { watch: deps.watch }),
      ...(deps.debounceMs !== undefined && { debounceMs: deps.debounceMs }),
    });
  };

  const follow = async (next: ViewTarget | null): Promise<void> => {
    watchFor(next);
    await model.follow(next);
  };

  // ---- browser ---------------------------------------------------------------

  let server: LiveServer | null = null;
  if (options.mode === "browser") {
    const source: LiveSource = {
      state: () => model.state(),
      subscribe: (listener) => model.subscribe(listener),
      async frame(query) {
        const viewed = model.viewed();
        if (!viewed) throw new CliError(2, "No photo to show.");
        const ask: FrameAsk = { ...query, encoding: "png", before: query.before || model.state().before };
        return (await frames.ask(frameAskKey(viewed, ask), render(ask)))?.bytes ?? null;
      },
      async command(action) {
        if (action === "before") {
          model.setBefore(!model.state().before);
          return true;
        }
        return (await deps.step?.(action === "next" ? 1 : -1)) ?? false;
      },
    };
    server = await startLiveServer({ port: options.port, source, assets: deps.assets ?? PAGE });
  }

  // ---- terminal --------------------------------------------------------------

  let drawing: Promise<void> = Promise.resolve();
  let unsubscribe = (): void => {};
  let moved = (): void => {};
  let redraw = (): void => {};
  if (options.mode === "terminal") {
    const detected = await (deps.detect ?? (() => detectGraphicsMode(env, options.graphics)))();
    if (detected.mode === "none") {
      throw new CliError(1, `This terminal can't show the picture: ${detected.reason}.`, `${COMMAND} view --browser shows it in the browser.`);
    }
    const mode = detected.mode;
    const screen = createTerminalLive((chunk) => out.writeRaw(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk));
    const dot = out.options.unicode ? " · " : " - ";
    let drawnKey: string | null = null;
    let failedKey: string | null = null;

    const draw = async (): Promise<void> => {
      const viewed = model.viewed();
      if (!viewed) return;
      const size = previewFrameSize(mode, detected.cell, options.widthCols ?? out.options.width, viewed.photo);
      const ask: FrameAsk = { ...size, region: null, before: model.state().before };
      const key = frameAskKey(viewed, ask);
      if (key === drawnKey) return;
      const started = Date.now();
      let frame: CachedFrame | null;
      try {
        frame = await frames.ask(key, render(ask));
      } catch (error) {
        if (failedKey !== key) out.warn({ message: error instanceof Error ? error.message : String(error) });
        failedKey = key;
        return;
      }
      // A newer ask took its place; that one draws.
      if (!frame) return;
      const { step } = model.state().photo ?? { step: { at: 1, of: 1 } };
      const caption = out.previewCaption({
        mode,
        trueColour: mode !== "blocks" || supportsTrueColour(env),
        width: frame.width,
        height: frame.height,
        ms: Date.now() - started,
      }) + `${dot}${model.state().before ? "before" : `step ${step.at} of ${step.of}`}`;
      const picture = { bytes: encodeForTerminal(mode, frame, env), rows: pictureRows(mode, frame, detected.cell), caption };
      const shown = deps.around ? deps.around(() => screen.show(picture)) : (screen.show(picture), true);
      if (shown) drawnKey = key;
    };
    const queueDraw = (): void => { drawing = drawing.then(draw); };
    unsubscribe = model.subscribe(queueDraw);
    moved = () => screen.moved();
    redraw = queueDraw;
  }

  await follow(target);
  if (server) {
    const { url } = server;
    if (options.open) (deps.openBrowser ?? ((u: string) => openBrowser(env.platform, u)))(url);
  } else redraw();

  return {
    mode: options.mode,
    url: server?.url ?? null,
    model,
    follow,
    async changed() {
      await model.refresh();
      redraw();
    },
    moved: () => moved(),
    async settled() {
      for (let seen = drawing; ; seen = drawing) {
        await seen;
        if (seen === drawing) return;
      }
    },
    async stop() {
      unsubscribe();
      stopWatching();
      await server?.close();
    },
  };
}

