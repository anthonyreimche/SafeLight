// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The develop program the open photo renders with, or the one any process
// version would, as describePipeline reads it from the calls the renderer
// makes. Read from the stores the render bridge feeds the renderer from, for
// Developer Tools ▸ Pipeline.

import { useMemo } from "react";
import { DEFAULT_DEVELOP_PARAMS, type DevelopParams } from "@/catalog/types";
import type { DisplaySpace } from "@/rendering/color-space";
import { useDisplayProfile } from "@/rendering/display-profile-store";
import { useDisplaySpace } from "@/rendering/display-space";
import { maskInstances } from "@/rendering/webgl/mask-stage-instances";
import { describePipeline, type PipelineRow } from "@/rendering/webgl/pipeline-description";
import { shaderVariantFor, type ProcessVersion } from "@/rendering/webgl/shaders";
import { useDevelopStore } from "@/state/develop-store";
import { resolvePipelineFor, usePipelineStore } from "./pipelines";
import { useRegistry } from "./registry";

/** Where the view's frames go. */
export interface ScreenTarget {
  space: DisplaySpace;
  /** The active monitor profile's description; null without one. */
  profile: string | null;
}

export const PIPELINE_VERSIONS: readonly ProcessVersion[] = [1, 2, 3];
// Picking version 3 shows it, though no photo can be on it yet.
const NEWEST: ProcessVersion = 3;

/** One of the open photo's params (the current default's with none open).
 *  Selected one at a time, so an edit to any other param, which swaps the
 *  params object, doesn't render the caller. */
const useOpenParam = <K extends keyof DevelopParams>(key: K): DevelopParams[K] =>
  useDevelopStore((s) => (s.photoId ? s.params : DEFAULT_DEVELOP_PARAMS)[key]);

// The renderer encodes version 3 frames for the display space only where it can
// tag the drawing buffer with it (its canTagBuffer, which resolves through this
// prototype). Anywhere else they are sRGB.
const canTagDrawingBuffer = (): boolean =>
  typeof WebGL2RenderingContext !== "undefined" && "drawingBufferColorSpace" in WebGL2RenderingContext.prototype;

/** The open photo and the process version its program is built for (the
 *  current defaults' with none open). */
export function useOpenProcessVersion(): { photoId: string | null; version: ProcessVersion } {
  const photoId = useDevelopStore((s) => s.photoId);
  const processVersion = useOpenParam("processVersion");
  return { photoId, version: shaderVariantFor(processVersion).version };
}

/** The rows of the program `version` builds for the open photo: the core
 *  blocks in order, the stages between them, the conversions, and every clip
 *  of the colour. Rebuilt only when the stages, the masks' stage copies, the
 *  version or the display transform change. */
export function usePipelineRows(version: ProcessVersion): PipelineRow[] {
  const registered = useRegistry((s) => s.processingStages);
  const transforms = useRegistry((s) => s.pipelines);
  const defaultTransform = usePipelineStore((s) => s.activeId);
  const masks = useOpenParam("masks");
  const displayTransform = useOpenParam("displayTransform");

  // The registered transforms and the Preferences default decide which one
  // resolvePipelineFor returns.
  const pipeline = useMemo(
    () => resolvePipelineFor(displayTransform),
    [displayTransform, transforms, defaultTransform],
  );
  const variant = shaderVariantFor(version, NEWEST);
  // The stages as render-bridge posts them to the worker, with the copies the
  // photo's masks call for, as the renderer builds its program. Every brush dab
  // replaces the masks but rarely the copies, so the rows key on the copies'
  // sig, as the renderer keys its injection.
  const copies = maskInstances(Object.values(registered), masks, variant);
  return useMemo(
    () => describePipeline(copies.stages, variant, pipeline),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [registered, copies.sig, version, pipeline],
  );
}

/** The space this window's frames are drawn in, and the monitor profile. */
export function usePipelineScreen(): ScreenTarget {
  const space = useDisplaySpace();
  const profile = useDisplayProfile((s) => (s.status === "active" ? s.description : null));
  return { space: canTagDrawingBuffer() ? space : "srgb", profile };
}
