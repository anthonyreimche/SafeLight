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
import {
  emitUniformDecl,
  extractHelperNames,
  helperPrefix,
  rewriteGlsl,
  uniformPrefix,
} from "@/rendering/webgl/shader-compiler";
import type { ContributedBinding } from "@/rendering/webgl/stage-injection";
import { getParamDescriptor } from "./param-registry";
import { bagDiffersFromDefault, useRegistry, type RegisteredPipeline } from "./registry";

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
  /** The uniforms the transform's GLSL reads, declared under its namespace.
   *  Empty ("", and `bindings` []) for a transform with helpers that declares
   *  none; absent without glsl, or with neither declarations nor helpers. */
  uniformDecls?: string;
  /** The bag key each of those uniforms binds from, and its default. */
  bindings?: readonly ContributedBinding[];
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

/** The bag key a transform's derived uniform travels under to a renderer:
 *  "#" can't appear in a param key, so it can never be stored as one. */
export function derivedKey(transformId: string, key: string): string {
  return `${transformId}#${key}`;
}

function build(id: string, c: RegisteredPipeline | undefined): ResolvedPipeline {
  const skipBaseCurve = c?.skipBaseCurve ?? false;
  const skipToneShoulder = c?.skipToneShoulder ?? false;
  if (!c?.glsl && !skipBaseCurve && !skipToneShoulder) return BUILTIN_RESOLVED;
  const flags = `${skipBaseCurve ? "b" : "-"}${skipToneShoulder ? "s" : "-"}`;
  const declared = c?.derive?.uniforms ?? c?.params ?? [];
  if (!c?.glsl || (declared.length === 0 && !c.helpers)) {
    const glsl = c?.glsl || null;
    return { id, glsl, skipBaseCurve, skipToneShoulder, sig: `${id}\n${flags}\n${glsl ?? ""}` };
  }
  const uPfx = uniformPrefix(id);
  const helpers = c.helpers ?? "";
  const glsl = rewriteGlsl(
    helpers ? `${helpers}\n${c.glsl}` : c.glsl,
    declared,
    uPfx,
    helperPrefix(id),
    extractHelperNames(helpers),
  );
  const derived = c.derive !== undefined;
  const bindings = declared.map((u) => ({
    qualifiedKey: derived ? derivedKey(id, u.key) : `${id}.${u.key}`,
    glslName: uPfx + u.key,
    glslType: u.glslType,
    default: u.default,
  }));
  const uniformDecls = declared.map((u) => emitUniformDecl(u, uPfx)).join("\n");
  const mode = derived ? "derive" : "params";
  return {
    id,
    glsl,
    skipBaseCurve,
    skipToneShoulder,
    uniformDecls,
    bindings,
    sig: `${id}\n${flags}\n${mode}\n${uniformDecls}\n${glsl}`,
  };
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

/** The bag keys of a registered transform's params, "{id}.{key}". */
export function transformParamKeys(id: string): string[] {
  const c = useRegistry.getState().pipelines[id];
  return (c?.params ?? []).map((u) => `${id}.${u.key}`);
}

/** What the Display transform preset field carries besides the pick: the
 *  params of the transform a photo with `displayTransform` renders with. */
export interface TransformPresetField {
  bagKeys: string[];
  /** Each param's default, carried for a key the bag holds no value for, so
   *  the copy sets every one of a target's settings to the source's. */
  bagDefaults: Record<string, unknown>;
  /** True when one of them differs from its default in the bag. */
  changed: boolean;
}

export function transformPresetField(
  displayTransform: string | null,
  bag: Readonly<Record<string, unknown>>,
): TransformPresetField {
  const bagKeys = transformParamKeys(effectivePipelineId(displayTransform));
  const bagDefaults: Record<string, unknown> = {};
  let changed = false;
  for (const k of bagKeys) {
    const descriptor = getParamDescriptor(k);
    if (!descriptor) continue;
    bagDefaults[k] = descriptor.default;
    if (bagDiffersFromDefault(bag[k], descriptor.default)) changed = true;
  }
  return { bagKeys, bagDefaults, changed };
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
