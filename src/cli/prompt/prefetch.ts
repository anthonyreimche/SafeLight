// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// While one open photo is on screen, the next is rendered in the background
// and kept in the prompt's preview cache, so `next` shows it at once.
// The engine answers one request at a time, so a typed command stops the
// prefetch first, with the engine's cancel, and never waits behind it.

import path from "node:path";
import type { EngineEvent } from "@/engine/protocol";
import type { EngineClient } from "../engine-client";
import { createProjectService } from "../project";
import { isFrame, newRequestId, previewFrameSize, projectWire } from "../preview";
import { catalogueStamp, frameKey, lookKey, type CachedFrame, type PreviewCache } from "../preview-cache";
import type { CliEnv } from "../types";
import { installHost } from "./sources";

/** How wide the prompt shows the open photo, in terminal columns. */
export const PICTURE_COLUMNS = 28;

/** Renders in the background until `signal` stops it. `already` says whether a key rendered before;
 *  the job returns the key it rendered (photo and edit step), or null when it rendered nothing. */
export type PrefetchJob = (signal: AbortSignal, already: (key: string) => boolean) => Promise<string | null>;

export interface Prefetcher {
  /** Runs `job` once the one running now has stopped. */
  start(job: PrefetchJob): void;
  /** Stops the job that runs, if any; resolves once it has let go of the engine. */
  stop(): Promise<void>;
}

export function createPrefetcher(): Prefetcher {
  const rendered = new Set<string>();
  let running: { controller: AbortController; finished: Promise<void> } | null = null;

  async function stop(): Promise<void> {
    const job = running;
    running = null;
    if (!job) return;
    job.controller.abort();
    await job.finished;
  }

  return {
    start(job) {
      const before = stop();
      const controller = new AbortController();
      const finished = before
        .then(() => (controller.signal.aborted ? null : job(controller.signal, (key) => rendered.has(key))))
        .then(
          (key) => { if (key !== null && !controller.signal.aborted) rendered.add(key); },
          // A prefetch that fails costs nothing: the command that shows the photo says why.
          () => {},
        );
      running = { controller, finished };
    },
    stop,
  };
}

/** Renders `abs` through `engine` as the next `preview` of it will ask for, and keeps the frame in `cache`.
 *  Returns the frame's key, or null when it rendered nothing: no picture shown yet to go by, or already kept. */
export async function prefetchPreview(env: CliEnv, abs: string, engine: EngineClient, signal: AbortSignal, cache: PreviewCache): Promise<string | null> {
  const drawn = cache.drawnAs;
  if (!drawn || drawn.mode === "none") return null;
  const projects = createProjectService(env, installHost(env));
  const ref = await projects.find(abs);
  if (!ref || signal.aborted) return null;
  const p = env.platform === "win32" ? path.win32 : path.posix;
  const catalogue = await catalogueStamp(ref.workingDir);
  const session = await projects.openRead(ref);
  let found;
  try {
    const photo = session.photoByRelPath(p.relative(ref.root, abs));
    found = photo && { photo, state: await session.edit(photo.id) };
  } finally {
    await session.close();
  }
  if (!found) return null;
  const { photo, state } = found;
  const size = previewFrameSize(drawn.mode, drawn.cell, PICTURE_COLUMNS, photo);
  const key = frameKey(lookKey(photo, state), size, catalogue);
  if (cache.get(key) || signal.aborted) return null;

  let frame: CachedFrame | null = null;
  let announced: Extract<EngineEvent, { type: "frame" }> | null = null;
  // Read to the engine's "done" even when stopped, so the session keeps its engine.
  for await (const item of engine.request({ id: newRequestId(), type: "preview", project: projectWire(ref), photoId: photo.id, ...size, ...(catalogue !== undefined && { catalogue }) }, { signal })) {
    if (isFrame(item)) {
      if (announced && item.frame === announced.frame) frame = { width: announced.width, height: announced.height, encoding: announced.encoding, bytes: item.bytes };
    } else if (item.type === "frame") {
      announced = item;
    }
  }
  if (!frame) return null;
  cache.put(key, frame);
  return key;
}
