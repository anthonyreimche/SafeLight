// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The prompt's rendered previews, kept by photo, look and size. The open
// photos' prefetch fills it, so `next` shows a photo already rendered without
// waiting on the engine. A command run once has no use for it.

import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { CatalogPhoto, EditState } from "@/catalog/types";
import type { CellSize } from "./terminal-image";
import type { GraphicsMode } from "./types";

export interface CachedFrame { width: number; height: number; encoding: "png" | "rgba"; bytes: Uint8Array }

/** What the engine is asked to render for one preview. */
export interface FrameSize { width: number; height: number; encoding: "png" | "rgba" }

export interface PreviewCache {
  get(key: string): CachedFrame | undefined;
  put(key: string, frame: CachedFrame): void;
  /** How the last preview was drawn here, so a prefetch renders exactly what the next one asks for. */
  drawnAs: { mode: GraphicsMode; cell?: CellSize } | null;
}

/** Enough for the photos either side of the one on screen, at a 28-column picture's few hundred kilobytes each. */
const KEPT = 8;

export function createPreviewCache(kept: number = KEPT): PreviewCache {
  const frames = new Map<string, CachedFrame>();
  return {
    get(key) {
      const frame = frames.get(key);
      if (frame) {
        frames.delete(key);
        frames.set(key, frame);
      }
      return frame;
    },
    put(key, frame) {
      frames.delete(key);
      frames.set(key, frame);
      while (frames.size > kept) frames.delete(frames.keys().next().value as string);
    },
    drawnAs: null,
  };
}

/** The photo as it looks now: its turn and the step it is on. The step's own content is hashed, since an
 *  undo followed by a new edit lands a different look on the same place in the history. */
export function lookKey(photo: Pick<CatalogPhoto, "id" | "rotation">, state: EditState | undefined): string {
  const step = state?.stack[state.currentIndex];
  const look = step ? createHash("sha1").update(JSON.stringify(step)).digest("hex").slice(0, 16) : "as-shot";
  return `${photo.id}:${photo.rotation ?? 0}:${state?.currentIndex ?? 0}:${look}`;
}

/** `catalogue` is the stamp the frame was rendered at: a frame from before a save isn't shown after it. */
export const frameKey = (look: string, size: FrameSize, catalogue?: string): string =>
  `${look}|${size.width}x${size.height}|${size.encoding}${catalogue === undefined ? "" : `|${catalogue}`}`;

/** The catalogue file's modified time and size, which change with every save; undefined when there is none.
 *  A preview request carries it, so a warm engine reads the project again after a save. */
export async function catalogueStamp(workingDir: string): Promise<string | undefined> {
  try {
    const info = await stat(path.join(workingDir, "catalog.json"));
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return undefined;
  }
}
