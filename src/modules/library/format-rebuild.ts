// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { DECODER_FORMATS, formatOf } from "@/catalog/image-decoders";
import { projectPassSignal } from "@/project/project-store";
import { getSettings } from "@/state/settings-store";
import { useCatalogStore } from "@/state/catalog-store";
import { rebuildThumbnails } from "./import-passes";

const running = new Map<string, AbortController>();

/** Rebuild, in the background, the grid previews of the open project's photos
 *  of format `formatId`, after its decoders were reordered. A photo showing an
 *  edit keeps that preview, and a RAW's grid preview is the camera's own unless
 *  previews are rendered, so neither is touched. A run of the same format still
 *  going is stopped for this one; leaving the project stops it too. */
export function rebuildFormatPreviews(formatId: string): void {
  running.get(formatId)?.abort();
  running.delete(formatId);
  const photos = useCatalogStore
    .getState()
    .photos.filter((p) => formatOf(p.filename)?.id === formatId && p.previewEdit === undefined);
  const raw = DECODER_FORMATS.find((format) => format.id === formatId)?.raw ?? false;
  if (photos.length === 0 || (raw && getSettings().previewSource !== "rendered")) return;

  const controller = new AbortController();
  running.set(formatId, controller);
  const project = projectPassSignal();
  const stop = () => controller.abort();
  if (project?.aborted) controller.abort();
  else project?.addEventListener("abort", stop, { once: true });

  void rebuildThumbnails(
    photos,
    undefined,
    (p, change) => useCatalogStore.getState().mergeRebuiltPhoto(p.id, change),
    controller.signal,
  ).finally(() => {
    project?.removeEventListener("abort", stop);
    if (running.get(formatId) === controller) running.delete(formatId);
  });
}
