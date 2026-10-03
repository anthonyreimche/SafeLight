// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Render-pipeline engine: extensions register display transforms (tone
// mappers) through the registry. Each photo picks one in its develop params
// (`displayTransform`); a photo without a pick follows the default chosen in
// Preferences, which is persisted and shared across windows like themes.
// Renderers are handed the resolved pipeline of the photo they draw and swap
// to a cached program when it changes.

import { create } from "zustand";
import type { DevelopParams } from "@/catalog/types";
import { useRegistry, type RegisteredPipeline } from "./registry";

const PIPELINE_KEY = "sl_pipeline";
/** The stock Safelight transform baked into the fragment shader: the last
 *  fallback when neither a photo's pick nor the default is registered. */
export const DEFAULT_PIPELINE = "core.pipeline";

/** The Preferences default, followed by photos without their own pick. */
export const usePipelineStore = create<{ activeId: string }>(() => ({
  activeId: DEFAULT_PIPELINE,
}));

export interface ResolvedPipeline {
  id: string;
  /** GLSL defining pipelineToDisplay, or null for the built-in transform. */
  glsl: string | null;
  skipBaseCurve: boolean;
  skipToneShoulder: boolean;
  /** Change signature the renderer caches its compiled programs and their
   *  flags by: it differs whenever the shader or either flag does. */
  sig: string;
}

/** Stable identity for the built-in fallback (sig "" = stock program). */
export const BUILTIN_RESOLVED: ResolvedPipeline = {
  id: DEFAULT_PIPELINE,
  glsl: null,
  skipBaseCurve: false,
  skipToneShoulder: false,
  sig: "",
};

/** The pipeline id a photo's `displayTransform` renders with: its own pick
 *  while registered, else the Preferences default while registered, else the
 *  built-in. */
export function effectivePipelineId(displayTransform: string | null): string {
  const reg = useRegistry.getState().pipelines;
  if (displayTransform && reg[displayTransform]) return displayTransform;
  const fallback = usePipelineStore.getState().activeId;
  return reg[fallback] ? fallback : DEFAULT_PIPELINE;
}

function build(id: string, c: RegisteredPipeline | undefined): ResolvedPipeline {
  const glsl = c?.glsl || null;
  const skipBaseCurve = c?.skipBaseCurve ?? false;
  const skipToneShoulder = c?.skipToneShoulder ?? false;
  if (!glsl && !skipBaseCurve && !skipToneShoulder) return BUILTIN_RESOLVED;
  const flags = `${skipBaseCurve ? "b" : "-"}${skipToneShoulder ? "s" : "-"}`;
  const sig = `${id}\n${flags}\n${glsl ?? ""}`;
  return { id, glsl, skipBaseCurve, skipToneShoulder, sig };
}

// Resolution runs per render request; cache per id so the steady state is a
// map hit, and drop the cache whenever the registry's pipelines change.
const resolved = new Map<string, ResolvedPipeline>();
let resolvedFrom: unknown = null;

/** The pipeline a photo with this `displayTransform` renders with. */
export function resolvePipelineFor(displayTransform: string | null): ResolvedPipeline {
  const reg = useRegistry.getState().pipelines;
  if (resolvedFrom !== reg) {
    resolved.clear();
    resolvedFrom = reg;
  }
  const id = effectivePipelineId(displayTransform);
  let p = resolved.get(id);
  if (!p) {
    p = build(id, reg[id]);
    resolved.set(id, p);
  }
  return p;
}

/** The Preferences default's pipeline — what a photo without a pick uses. */
export function resolveDefaultPipeline(): ResolvedPipeline {
  return resolvePipelineFor(null);
}

/** The part of a renderer that takes one photo's look. */
export interface PhotoRenderTarget {
  setActivePipeline(pipeline: ResolvedPipeline): void;
  setParams(params: DevelopParams): void;
}

/** Hand a renderer one photo's params together with the display transform
 *  they pick, so no render path can draw a photo with another's transform. */
export function setPhotoParams(target: PhotoRenderTarget, params: DevelopParams): void {
  target.setActivePipeline(resolvePipelineFor(params.displayTransform));
  target.setParams(params);
}

/** Run `render` with `pipeline` swapped in, then put `restore` back, even if
 *  the render throws, so a one-off render never leaves the renderer on
 *  another photo's transform. */
export function withPipeline<T>(
  target: Pick<PhotoRenderTarget, "setActivePipeline">,
  pipeline: ResolvedPipeline,
  restore: ResolvedPipeline,
  render: () => T,
): T {
  target.setActivePipeline(pipeline);
  try {
    return render();
  } finally {
    target.setActivePipeline(restore);
  }
}

/** Set the Preferences default (see usePipelineStore). */
export function applyPipeline(id: string): void {
  usePipelineStore.setState({ activeId: id });
  try {
    localStorage.setItem(PIPELINE_KEY, id);
  } catch {}
}

/** Restore the saved choice and follow changes from other windows. */
export function initPipelines(): void {
  try {
    const saved = localStorage.getItem(PIPELINE_KEY);
    if (saved) usePipelineStore.setState({ activeId: saved });
  } catch {}
  window.addEventListener("storage", (e) => {
    if (e.key === PIPELINE_KEY && e.newValue)
      usePipelineStore.setState({ activeId: e.newValue });
  });
}
