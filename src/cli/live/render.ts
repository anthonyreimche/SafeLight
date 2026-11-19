// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// One frame of the viewed photo, rendered by the engine: the whole photo or a
// window of it, as it is now or as it was at its first step.

import type { EngineEvent, PreviewRegion } from "@/engine/protocol";
import type { EngineClient } from "../engine-client";
import { asShotOf, engineError, isFrame, lookAtStep, newRequestId, projectWire } from "../preview";
import type { CachedFrame } from "../preview-cache";
import { CliError } from "../types";
import type { ViewedPhoto } from "./model";

/** What a view asks the engine for: a frame inside width × height, of `region` (null: the whole photo). */
export interface FrameAsk {
  width: number;
  height: number;
  encoding: "png" | "rgba";
  region: PreviewRegion | null;
  before: boolean;
}

/** The key a frame of `viewed` for `ask` is kept and shared under. */
export function frameAskKey(viewed: ViewedPhoto, ask: FrameAsk): string {
  const region = ask.region ? `${ask.region.x},${ask.region.y},${ask.region.w},${ask.region.h}` : "all";
  return `${viewed.look}|${ask.before ? "before" : "now"}|${ask.width}x${ask.height}|${ask.encoding}|${region}`;
}

export async function renderViewed(engine: EngineClient, viewed: ViewedPhoto, ask: FrameAsk): Promise<CachedFrame> {
  const { photo, edit, project } = viewed;
  const overrides = ask.before ? lookAtStep(edit, 1, asShotOf(photo)).overrides : undefined;
  let announced: Extract<EngineEvent, { type: "frame" }> | null = null;
  let bytes: Uint8Array | null = null;
  const events = engine.request({
    id: newRequestId(),
    type: "preview",
    project: projectWire(project),
    photoId: photo.id,
    width: ask.width,
    height: ask.height,
    encoding: ask.encoding,
    ...(overrides && { overrides }),
    ...(ask.region && { region: ask.region }),
    ...(viewed.catalogue !== undefined && { catalogue: viewed.catalogue }),
  });
  for await (const item of events) {
    if (isFrame(item)) {
      if (announced && item.frame === announced.frame) bytes = item.bytes;
    } else if (item.type === "frame") {
      announced = item;
    } else if (item.type === "error") {
      throw engineError(item);
    }
  }
  if (!announced || !bytes) throw new CliError(3, "The engine finished without sending the image.");
  return { width: announced.width, height: announced.height, encoding: announced.encoding, bytes };
}
